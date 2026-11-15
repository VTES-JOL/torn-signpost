/**
 * A fake Archon for tests: the routes we use, behaving as the spike found the real one does
 * (docs/m7-plan.md, "Spike findings"). It's a fetch handler, so unit tests inject `fake.fetch`;
 * `fake-server.ts` serves it over HTTP for the end-to-end tests.
 *
 * Simplifications: anyone signed in approves any consent; a table's VPs are checked only coarsely
 * (`plausibleTable`); finals and the rest of Archon's actions aren't there yet.
 */
import { createHash, randomBytes } from 'node:crypto';
import { plausibleTable, tableResults, tableSizes } from './scoring.ts';
import type { Action, Member, Player, Standing, Table, Tournament } from './types.ts';

interface Grant {
  sub: string;
  scope: string;
  tournament?: string;
  /** Present on codes only. */
  challenge?: string;
  redirect?: string;
}

const nowIso = () => new Date().toISOString();
const secret = () => randomBytes(24).toString('base64url');

export class FakeArchon {
  readonly members = new Map<string, Member>();
  readonly tournaments = new Map<string, Tournament & { organizers_uids: string[] }>();
  readonly decks = new Map<string, Record<string, unknown>>();
  /** The member who approves at /consent, as if signed in to Archon. None: they decline. */
  signedIn: string | undefined;
  /** Every action applied, in order, per tournament (for assertions). */
  readonly log: { tournament: string; action: Action }[] = [];
  private readonly codes = new Map<string, Grant>();
  private readonly access = new Map<string, Grant>();
  private readonly refreshes = new Map<string, Grant>();

  constructor(
    readonly client: { id: string; secret: string; redirectUris: string[] },
    readonly baseUrl = 'https://archon.test',
  ) {}

  addMember(m: Partial<Member> & { name: string }): Member {
    const member: Member = {
      uid: m.uid ?? crypto.randomUUID(),
      name: m.name,
      vekn_id: m.vekn_id ?? null,
    };
    this.members.set(member.uid, member);
    return member;
  }

  addTournament(organizer: string, t: Partial<Tournament> = {}): Tournament {
    const tournament = {
      uid: crypto.randomUUID(),
      name: 'Fake tournament',
      state: 'Planned' as const,
      format: 'Standard',
      online: true,
      start: null,
      finish: null,
      round_time: 7200,
      max_rounds: 3,
      multideck: false,
      players: [],
      rounds: [],
      standings: [],
      finals: null,
      modified: nowIso(),
      ...t,
      organizers_uids: [organizer],
    };
    this.tournaments.set(tournament.uid, tournament);
    return tournament;
  }

  /** Make an access token directly (tests that skip the consent dance). */
  grant(sub: string, scope: string, tournament?: string): string {
    const kept = { sub, scope, ...(tournament ? { tournament } : {}) };
    const token = jwt(kept);
    this.access.set(token, kept);
    return token;
  }

  /** Every access token runs out, as after an hour: the next call has to refresh. */
  expireAccess(): void {
    this.access.clear();
  }

  /** The organiser revokes our grants for a tournament (in Archon's consents). */
  revoke(tournament: string): void {
    for (const store of [this.access, this.refreshes]) {
      for (const [k, g] of store) if (g.tournament === tournament) store.delete(k);
    }
  }

  /** Apply an action as the tournament's organiser would in Archon. */
  act(tournament: string, action: Action): void {
    const t = this.tournaments.get(tournament);
    if (!t) throw new Error(`No tournament ${tournament}`);
    apply(t, action, this.members);
    t.modified = nowIso();
    this.log.push({ tournament, action });
  }

  readonly fetch: typeof fetch = async (input, init) =>
    this.handle(new Request(input instanceof Request ? input : new URL(String(input)), init));

  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    try {
      if (req.method === 'GET' && path === '/consent') return this.consent(url);
      if (req.method === 'POST' && path === '/oauth/token') return await this.token(req);
      if (req.method === 'GET' && path === '/oauth/userinfo') return this.userinfo(req);
      if (req.method === 'GET' && path === '/stream') return this.stream(req, url);
      const action = path.match(/^\/api\/tournaments\/([^/]+)\/action$/);
      if (req.method === 'POST' && action?.[1]) return await this.action(req, action[1]);
      return json(404, { status_code: 404, detail: 'Not Found' });
    } catch (e) {
      if (e instanceof Refusal) return json(e.status, e.body);
      throw e;
    }
  }

  private consent(url: URL): Response {
    const q = Object.fromEntries(url.searchParams);
    if (
      q.client_id !== this.client.id ||
      !this.client.redirectUris.includes(q.redirect_uri ?? '')
    ) {
      return json(400, { detail: 'Unknown client or redirect URI' });
    }
    const back = new URL(q.redirect_uri as string);
    if (q.state) back.searchParams.set('state', q.state);
    if (!this.signedIn) {
      back.searchParams.set('error', 'access_denied');
    } else {
      if (q.scope === 'event:run') {
        const t = this.tournaments.get(q.tournament ?? '');
        if (!t?.organizers_uids.includes(this.signedIn)) {
          back.searchParams.set('error', 'access_denied');
          return redirect(back);
        }
      }
      const code = secret();
      this.codes.set(code, {
        sub: this.signedIn,
        scope: q.scope ?? '',
        challenge: q.code_challenge ?? '',
        redirect: q.redirect_uri ?? '',
        ...(q.tournament ? { tournament: q.tournament } : {}),
      });
      back.searchParams.set('code', code);
    }
    return redirect(back);
  }

  private async token(req: Request): Promise<Response> {
    if (req.headers.get('authorization'))
      return json(401, { detail: 'Invalid client credentials' });
    const f = Object.fromEntries(new URLSearchParams(await req.text()));
    if (f.client_id !== this.client.id || f.client_secret !== this.client.secret) {
      return json(401, { detail: 'Invalid client credentials' });
    }
    let grant: Grant | undefined;
    if (f.grant_type === 'authorization_code') {
      grant = this.codes.get(f.code ?? '');
      this.codes.delete(f.code ?? '');
      const challenge = createHash('sha256')
        .update(f.code_verifier ?? '')
        .digest('base64url');
      if (!grant || grant.challenge !== challenge || grant.redirect !== f.redirect_uri) {
        return json(400, { error: 'invalid_grant', detail: 'Invalid authorization code' });
      }
    } else if (f.grant_type === 'refresh_token') {
      grant = this.refreshes.get(f.refresh_token ?? '');
      this.refreshes.delete(f.refresh_token ?? ''); // rotated, as Archon does
      if (!grant) return json(400, { error: 'invalid_grant', detail: 'Invalid refresh token' });
    } else if (f.grant_type === 'client_credentials') {
      const token = secret();
      this.access.set(token, { sub: '', scope: 'api:read' });
      return json(200, {
        access_token: token,
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'api:read',
      });
    } else {
      return json(400, { error: 'unsupported_grant_type' });
    }
    const { challenge: _c, redirect: _r, ...kept } = grant;
    const access = jwt(kept);
    const refresh = secret();
    this.access.set(access, kept);
    this.refreshes.set(refresh, kept);
    return json(200, {
      access_token: access,
      refresh_token: refresh,
      token_type: 'Bearer',
      expires_in: 3600,
      scope: kept.scope,
    });
  }

  private bearer(req: Request): Grant {
    const token = req.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
    const grant = this.access.get(token);
    if (!grant) throw new Refusal(401, { detail: 'Invalid or expired token' });
    return grant;
  }

  private userinfo(req: Request): Response {
    const g = this.bearer(req);
    const m = this.members.get(g.sub);
    if (!m) return json(401, { detail: 'Invalid token' });
    return json(200, { sub: m.uid, roles: [], vekn_id: m.vekn_id, capabilities: [] });
  }

  private forTournament(req: Request, uid: string) {
    const g = this.bearer(req);
    if (g.scope !== 'event:run' || g.tournament !== uid) {
      throw new Refusal(403, {
        detail: 'This token acts only on the tournament it was granted for',
      });
    }
    const t = this.tournaments.get(uid);
    if (!t) throw new Refusal(404, { detail: 'Tournament not found' });
    return t;
  }

  private stream(req: Request, url: URL): Response {
    const g = this.bearer(req);
    const uid = url.searchParams.get('tournament');
    if (!uid) {
      return json(403, {
        detail: g.tournament
          ? 'This token acts only on the tournament it was granted for'
          : 'Invalid token',
      });
    }
    const t = this.forTournament(req, uid);
    const uids = new Set([...t.players.map((p) => p.user_uid), ...t.organizers_uids]);
    const users = [...uids]
      .map((u) => this.members.get(u))
      .filter(Boolean)
      // The real stream also sends contact details: the client must drop them.
      .map((m) => ({ ...m, contact_email: `${m?.uid}@example.invalid` }));
    const frames = [
      { type: 'tournament', data: t },
      { type: 'users', data: users },
      { type: 'sync_complete', timestamp: nowIso() },
    ];
    return new Response(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(''), {
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    });
  }

  private async action(req: Request, uid: string): Promise<Response> {
    const t = this.forTournament(req, uid);
    const a = (await req.json()) as Action;
    apply(t, a, this.members);
    if (a.type === 'UpsertDeck') this.decks.set(`${uid}/${a.player_uid}`, a.deck);
    t.modified = nowIso();
    this.log.push({ tournament: uid, action: a });
    const { players: _p, rounds: _r, standings: _s, ...summary } = t;
    return json(201, summary);
  }
}

class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(String(body.detail));
  }
}

const refuse = (code: string, detail: string, params: Record<string, string> = {}): never => {
  throw new Refusal(400, { detail, code, params });
};

function inState(t: Tournament, expected: Tournament['state']) {
  if (t.state !== expected) {
    refuse(
      'tournament.wrong_state',
      `Tournament must be in ${expected} state (currently ${t.state})`,
      {
        expected,
        current: t.state,
      },
    );
  }
}

function player(t: Tournament, uid: string): Player {
  return (
    t.players.find((p) => p.user_uid === uid) ??
    refuse('tournament.unknown_player', 'Player not found')
  );
}

function apply(t: Tournament, a: Action, members: Map<string, Member>) {
  switch (a.type) {
    case 'OpenRegistration':
      inState(t, 'Planned');
      t.state = 'Registration';
      return;
    case 'CloseRegistration':
      inState(t, 'Registration');
      t.state = 'Waiting';
      return;
    case 'AddPlayer':
    case 'Register': {
      const m = members.get(a.user_uid);
      if (!m) throw new Refusal(404, { status_code: 404, detail: 'User not found' });
      if (!m.vekn_id) refuse('tournament.vekn_id_required', 'Player must have a VEKN ID');
      if (t.players.some((p) => p.user_uid === a.user_uid)) return;
      t.players.push({
        user_uid: a.user_uid,
        state: 'Registered',
        result: { gw: 0, vp: 0, tp: 0 },
        display_name: null,
        missing_decklist: true,
        finalist: false,
        toss: 0,
      });
      return;
    }
    case 'Unregister':
      t.players = t.players.filter((p) => p.user_uid !== a.player_uid);
      return;
    case 'DropOut':
      player(t, a.player_uid).state = 'Finished';
      return;
    case 'CheckIn': {
      inState(t, 'Waiting');
      const p = player(t, a.player_uid);
      const m = members.get(p.user_uid);
      if (!m?.vekn_id) refuse('tournament.vekn_id_required', 'Player must have a VEKN ID');
      p.state = 'Checked-in';
      return;
    }
    case 'CheckInAll':
      inState(t, 'Waiting');
      for (const p of t.players) if (p.state === 'Registered') p.state = 'Checked-in';
      return;
    case 'UpsertDeck':
      player(t, a.player_uid).missing_decklist = false;
      return;
    case 'StartRound': {
      inState(t, 'Waiting');
      const ready = t.players.filter((p) => p.state === 'Checked-in').map((p) => p.user_uid);
      if (ready.length < 4)
        refuse('tournament.not_enough_players', 'Need at least 4 checked-in players');
      let seating = a.seating;
      if (!seating) {
        const sizes =
          tableSizes(ready.length) ??
          refuse('tournament.seating', 'No seating for that many players');
        seating = sizes.map((n, k) => {
          const from = sizes.slice(0, k).reduce((a, b) => a + b, 0);
          return ready.slice(from, from + n);
        });
      }
      t.rounds.push(
        seating.map((uids) => ({
          seating: uids.map((player_uid) => ({ player_uid, result: { gw: 0, vp: 0, tp: 0 } })),
          state: 'In Progress',
        })),
      );
      for (const p of t.players) if (seating.flat().includes(p.user_uid)) p.state = 'Playing';
      t.state = 'Playing';
      return;
    }
    case 'SetScore': {
      inState(t, 'Playing');
      const round = t.rounds[a.round] ?? refuse('tournament.invalid_round', 'Invalid round number');
      const table: Table =
        round[a.table] ?? refuse('tournament.invalid_table', 'Invalid table number');
      for (const s of a.scores) {
        const seat = table.seating.find((x) => x.player_uid === s.player_uid);
        if (seat) seat.result = { gw: 0, tp: 0, vp: s.vp };
      }
      const vps = table.seating.map((s) => s.result?.vp ?? 0);
      if (plausibleTable(vps)) {
        tableResults(vps).forEach((r, i) => {
          const seat = table.seating[i];
          if (seat) seat.result = { vp: vps[i] ?? 0, ...r };
        });
        table.state = 'Finished';
      } else table.state = 'Invalid';
      return;
    }
    case 'FinishRound': {
      inState(t, 'Playing');
      const round = t.rounds.at(-1) ?? [];
      const open = round.flatMap((tb, i) => (tb.state === 'Finished' ? [] : [String(i + 1)]));
      if (open.length)
        refuse('tournament.tables_not_finished', `Tables ${open.join(', ')} not finished yet`, {
          tables: open.join(', '),
        });
      for (const p of t.players) if (p.state === 'Playing') p.state = 'Checked-in';
      t.standings = standings(t);
      t.state = 'Waiting';
      return;
    }
    default:
      refuse('internal', `Internal error: Unknown event type: ${(a as { type: string }).type}`);
  }
}

/** GW, then VP, then TP (3.1). */
function standings(t: Tournament): Standing[] {
  const total = new Map<string, { gw: number; vp: number; tp: number }>();
  for (const round of t.rounds) {
    for (const table of round) {
      if (table.state !== 'Finished') continue;
      for (const s of table.seating) {
        const r = total.get(s.player_uid) ?? { gw: 0, vp: 0, tp: 0 };
        total.set(s.player_uid, {
          gw: r.gw + (s.result?.gw ?? 0),
          vp: r.vp + (s.result?.vp ?? 0),
          tp: r.tp + (s.result?.tp ?? 0),
        });
      }
    }
  }
  return t.players
    .map((p) => ({
      user_uid: p.user_uid,
      ...(total.get(p.user_uid) ?? { gw: 0, vp: 0, tp: 0 }),
      toss: 0,
      finalist: false,
      withdrawn: false,
      disqualified: false,
    }))
    .sort((a, b) => b.gw - a.gw || b.vp - a.vp || b.tp - a.tp);
}

/** A JWT-shaped token, unsigned: callers read its claims, as they do Archon's. */
function jwt(claims: Omit<Grant, 'challenge' | 'redirect'>): string {
  const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return `${part({ alg: 'none' })}.${part({ ...claims, exp, jti: secret() })}.${secret()}`;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const redirect = (to: URL) =>
  new Response(null, { status: 302, headers: { location: to.toString() } });
