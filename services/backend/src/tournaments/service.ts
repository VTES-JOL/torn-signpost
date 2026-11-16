/**
 * Tournaments linked to Archon (docs/m7-plan.md M7.2). An organiser links an Archon tournament
 * they run by granting us `event:run` for it; we keep the grant (sealed) and a copy of Archon's
 * state for our pages, read again by polling while the tournament is under way (decision 6).
 * Archon is the source of truth.
 *
 * Players register here (M7.3): a linked Archon account with a VEKN number, and a legal deck of
 * theirs, copied so later edits don't change it. We send it to Archon with the organiser's grant
 * (decision 2): `AddPlayer` and `UpsertDeck`; dropping out is `Unregister` during registration and
 * `DropOut` after; checking in is `CheckIn`. Each action is followed by a fresh read.
 */
import {
  type Action,
  type ArchonConfig,
  ArchonError,
  act,
  readTournament,
  refresh,
  type Tokens,
  type Tournament,
  type TournamentView,
  tokenClaims,
} from '@torn-signpost/archon';
import type {
  ArchonLinkStart,
  DeckCards,
  DeckDetails,
  LinkTournamentRequest,
  RegisterRequest,
  TournamentDetails,
  TournamentEntry,
  TournamentList,
  TournamentPlayer,
  TournamentRound,
  TournamentStanding,
  TournamentSummary,
} from '@torn-signpost/protocol';
import type { Sealer } from '../archon/sealer.ts';
import { archon, requireUser } from '../archon/service.ts';
import { type Identity, placeholderName } from '../auth.ts';
import type { ArchonStore } from '../db/archon.ts';
import type {
  CachedTournament,
  Registration,
  TournamentMeta,
  TournamentStore,
  TournamentSummaryFields,
} from '../db/tournaments.ts';
import { ApiError } from '../errors.ts';

/**
 * Tournaments under way are read every poll (a minute); ones not started yet, this often, until
 * a day before they start (check-in opens when the organiser closes registration in Archon).
 */
const QUIET_POLL_MS = 15 * 60 * 1000;
const SOON_MS = 24 * 60 * 60 * 1000;
/** A poll skips a tournament read less than this long ago (a page's refresh, say). */
const MIN_POLL_MS = 45 * 1000;
/** Refresh access tokens this long before they run out. */
const EARLY_REFRESH_MS = 60 * 1000;
/** A read gives up after this: the Lambdas have 10 seconds. */
const READ_TIMEOUT_MS = 8 * 1000;
/** How long one process may hold the grant to refresh it. */
const LEASE_MS = 20 * 1000;

/**
 * The Cognito group that manages tournaments: links them, reads them now, unlinks them. A
 * tournament admin manages only tournaments they organise in Archon (docs/roles.md).
 */
export const TOURNAMENT_ADMIN = 'tournament_admin';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** The tournament fields we keep and show; the rest (check-in code, offline device…) aren't ours. */
const KEPT = [
  'uid',
  'name',
  'state',
  'format',
  'online',
  'start',
  'finish',
  'timezone',
  'country',
  'city',
  'venue',
  'description',
  'round_time',
  'max_rounds',
  'multideck',
  'decklist_required',
  'players',
  'rounds',
  'standings',
  'finals',
  'winner',
  'organizers_uids',
  'modified',
] as const;

export interface TournamentServiceDeps {
  store: TournamentStore;
  archonStore: ArchonStore;
  config: () => Promise<ArchonConfig>;
  sealer: Sealer;
  /** Starts an Archon sign-in for `sub` (ArchonService.begin). */
  begin: (sub: string, purpose: 'tournament', tournament: string) => Promise<string>;
  nameOf: (sub: string) => Promise<string | undefined>;
  /** One of the player's own decks, its latest version, checked (DeckService.ownLatest). */
  deckFor: (sub: string, deckId: string) => Promise<DeckDetails | undefined>;
  now?: () => Date;
  /** Waits between tries for a grant another process is refreshing. */
  sleep?: (ms: number) => Promise<void>;
}

/** Archon no longer honours the grant: it was revoked, or ran out. */
class GrantLost extends Error {}

export class TournamentService {
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: TournamentServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Where to send the organiser to grant us `event:run` for the tournament. */
  async startLink(identity: Identity, req: LinkTournamentRequest): Promise<ArchonLinkStart> {
    const user = requireTournamentAdmin(identity);
    const config = await this.deps.config();
    const uid = req.archon.match(UUID)?.[0]?.toLowerCase();
    if (!uid) {
      throw new ApiError(
        400,
        'archon_tournament',
        'Give the tournament’s address in Archon (…/tournaments/<id>)',
      );
    }
    if (/^https?:\/\//i.test(req.archon)) {
      const host = new URL(req.archon).host;
      if (host !== new URL(config.baseUrl).host) {
        throw new ApiError(
          400,
          'archon_tournament',
          `That isn’t a tournament on ${new URL(config.baseUrl).host}`,
        );
      }
    }
    return { url: await this.deps.begin(user.sub, 'tournament', uid) };
  }

  /** The organiser granted `event:run` (from ArchonService.complete): link the tournament. */
  async granted(sub: string, uid: string, tokens: Tokens): Promise<string> {
    const claims = tokenClaims(tokens.access_token);
    if (claims.tournament && claims.tournament !== uid) {
      throw new ApiError(400, 'archon_wrong_tournament', 'Archon granted a different tournament');
    }
    if (!tokens.refresh_token) {
      throw new ApiError(400, 'archon_refused', 'Archon gave no lasting grant: link it again');
    }
    const config = await this.deps.config();
    // Reading it checks the grant does reach this tournament.
    const view = await archon(() => readTournament(config, uid, tokens.access_token));
    const now = this.now();
    const previous = await this.deps.store.getMeta(uid);
    const meta: TournamentMeta = {
      ...summaryOf(view.tournament, config),
      organiser: sub,
      organiserArchonUid: claims.sub ?? null,
      linkedAt: previous?.linkedAt ?? now.toISOString(),
      updatedAt: now.toISOString(),
      polledAt: now.toISOString(),
      grant: 'ok',
      lastError: null,
    };
    await this.deps.store.putLink(
      meta,
      {
        refresh: await this.deps.sealer.seal(tokens.refresh_token, uid),
        access: await this.deps.sealer.seal(tokens.access_token, uid),
        accessExpires: Math.floor(now.getTime() / 1000) + tokens.expires_in,
        archonSub: claims.sub ?? null,
      },
      cached(view),
    );
    return uid;
  }

  async list(): Promise<TournamentList> {
    const metas = await this.deps.store.list();
    return { tournaments: await Promise.all(metas.map((m) => this.summary(m))) };
  }

  async get(identity: Identity, id: string): Promise<TournamentDetails> {
    const { meta, state } = await this.linked(id);
    return this.details(identity, meta, state);
  }

  /**
   * Register for the tournament, or change the deck registered while registration is open: the
   * player's own deck (its latest version, legal in the tournament's format), copied.
   */
  async register(identity: Identity, id: string, req: RegisterRequest): Promise<TournamentDetails> {
    const user = requireUser(identity);
    const { meta, state } = await this.linked(id);
    const t = state.tournament;
    if (!registrationOpen(t)) {
      throw new ApiError(409, 'registration_closed', 'Registration isn’t open for this tournament');
    }
    const format = deckFormatOf(t);
    if (!format) {
      throw new ApiError(
        400,
        'format_unsupported',
        `Registering here isn’t available for ${t.multideck ? 'multi-deck ' : ''}${t.format} tournaments yet`,
      );
    }
    const link = await this.deps.archonStore.getLink(user.sub);
    if (!link) {
      throw new ApiError(400, 'archon_account', 'Link your Archon account first, on Your account');
    }
    if (!link.veknId) {
      throw new ApiError(
        400,
        'vekn_id',
        'Archon registers only players with a VEKN number: a Prince can sponsor you for one. Then link your Archon account again',
      );
    }
    const previous = await this.deps.store.getRegistration(id, user.sub);
    if (previous && previous.archonUid !== link.archonUid) {
      throw new ApiError(
        409,
        'archon_account_changed',
        'You registered with another Archon account: drop out first',
      );
    }
    const player = t.players.find((p) => p.user_uid === link.archonUid);
    if (previous?.droppedAt || player?.state === 'Finished') {
      throw new ApiError(409, 'dropped', 'You’ve dropped out of this tournament');
    }
    const deck = await this.deps.deckFor(user.sub, req.deckId);
    if (!deck) throw new ApiError(404, 'not_found', 'No such deck');
    if (deck.format !== format) {
      throw new ApiError(400, 'deck_format', `This tournament needs a ${format} deck`);
    }
    if (!deck.legal) {
      throw new ApiError(400, 'deck_illegal', 'That deck isn’t legal: fix it in the deck builder');
    }
    // An organiser may have added them in Archon already: then it's only the deck.
    if (!player) await this.send(meta, { type: 'AddPlayer', user_uid: link.archonUid });
    await this.send(meta, {
      type: 'UpsertDeck',
      player_uid: link.archonUid,
      deck: { name: deck.name, comments: '', cards: archonCards(deck.cards) },
    });
    await this.deps.store.putRegistration({
      tournament: id,
      sub: user.sub,
      archonUid: link.archonUid,
      deck: { id: deck.id, version: deck.version, name: deck.name, cards: deck.cards },
      registeredAt: previous?.registeredAt ?? this.now().toISOString(),
    });
    await this.read(meta);
    return this.get(identity, id);
  }

  /**
   * Drop out: during registration, off the list (`Unregister`, which Archon allows only then);
   * after, out of the rounds to come (`DropOut`): Archon keeps them, finished.
   */
  async drop(identity: Identity, id: string): Promise<TournamentDetails> {
    const user = requireUser(identity);
    const { meta, state } = await this.linked(id);
    const t = state.tournament;
    const reg = await this.deps.store.getRegistration(id, user.sub);
    if (!reg || reg.droppedAt) {
      throw new ApiError(404, 'not_registered', 'You aren’t registered for this tournament');
    }
    if (t.state === 'Finished') throw new ApiError(409, 'finished', 'The tournament is over');
    const player = t.players.find((p) => p.user_uid === reg.archonUid);
    if (t.state === 'Registration') {
      if (player) await this.send(meta, { type: 'Unregister', user_uid: reg.archonUid });
      await this.deps.store.deleteRegistration(id, user.sub);
    } else {
      if (player && player.state !== 'Finished') {
        await this.send(meta, { type: 'DropOut', player_uid: reg.archonUid });
      }
      await this.deps.store.putRegistration({ ...reg, droppedAt: this.now().toISOString() });
    }
    await this.read(meta);
    return this.get(identity, id);
  }

  /** Check in for the next round, while Archon has check-in open (Waiting). */
  async checkIn(identity: Identity, id: string): Promise<TournamentDetails> {
    const user = requireUser(identity);
    let { meta, state } = await this.linked(id);
    // Check-in may have opened since we last read it.
    if (state.tournament.state !== 'Waiting' && (await this.read(meta))) {
      ({ meta, state } = await this.linked(id));
    }
    const t = state.tournament;
    if (t.state !== 'Waiting') {
      throw new ApiError(409, 'checkin_closed', 'Check-in isn’t open for this tournament');
    }
    const reg = await this.deps.store.getRegistration(id, user.sub);
    const player = reg && t.players.find((p) => p.user_uid === reg.archonUid);
    if (!reg || reg.droppedAt || !player || player.state === 'Finished') {
      throw new ApiError(404, 'not_registered', 'You aren’t registered for this tournament');
    }
    if (player.state !== 'Checked-in') {
      await this.send(meta, { type: 'CheckIn', player_uid: reg.archonUid });
    }
    await this.read(meta);
    return this.get(identity, id);
  }

  /** Read it from Archon now (tournament admins who organise it in Archon). */
  async refreshNow(identity: Identity, id: string): Promise<TournamentDetails> {
    const meta = await this.managed(identity, id);
    await this.read(meta);
    return this.get(identity, id);
  }

  /** Stop following it here (tournament admins who organise it in Archon). Archon's grant is
   * withdrawn there. */
  async unlink(identity: Identity, id: string): Promise<void> {
    await this.managed(identity, id);
    await this.deps.store.deleteLink(id);
  }

  /** The scheduled read (every minute): each tournament that's due, side by side. */
  async poll(): Promise<{ read: number; failed: number }> {
    const now = this.now().getTime();
    const due = (await this.deps.store.list()).filter((meta) => {
      if (meta.grant === 'lost' || meta.state === 'Finished') return false;
      const since = now - Date.parse(meta.polledAt);
      const soon = meta.start !== null && Date.parse(meta.start) - now < SOON_MS;
      const quiet = meta.state === 'Planned' || (meta.state === 'Registration' && !soon);
      return since >= (quiet ? QUIET_POLL_MS : MIN_POLL_MS);
    });
    const results = await Promise.all(due.map((meta) => this.read(meta)));
    const read = results.filter(Boolean).length;
    return { read, failed: results.length - read };
  }

  /** Read one tournament from Archon and keep it; a failure is recorded, not thrown. */
  private async read(meta: TournamentMeta): Promise<boolean> {
    const at = this.now().toISOString();
    try {
      const config = await this.deps.config();
      let view: TournamentView;
      try {
        view = await readTournament(config, meta.id, await this.accessToken(meta.id), {
          timeoutMs: READ_TIMEOUT_MS,
        });
      } catch (e) {
        // An access token Archon stopped honouring early: refresh once and try again.
        if (!(e instanceof ArchonError) || e.status !== 401) throw e;
        view = await readTournament(config, meta.id, await this.accessToken(meta.id, true), {
          timeoutMs: READ_TIMEOUT_MS,
        });
      }
      await this.deps.store.putState(summaryOf(view.tournament, config), at, cached(view));
      return true;
    } catch (e) {
      if (e instanceof GrantLost) {
        await this.deps.store.markFailed(meta.id, at, 'Archon no longer accepts our grant', true);
      } else if (e instanceof ArchonError) {
        await this.deps.store.markFailed(meta.id, at, e.message);
      } else {
        console.error('reading a tournament from Archon failed', { id: meta.id, error: e });
        await this.deps.store.markFailed(meta.id, at, 'Reading it from Archon failed');
      }
      return false;
    }
  }

  /** Send an action to Archon with the organiser's grant. */
  private async send(meta: TournamentMeta, action: Action): Promise<void> {
    if (meta.grant === 'lost') throw grantLostError();
    const config = await this.deps.config();
    try {
      await archon(async () => {
        try {
          await act(config, meta.id, await this.accessToken(meta.id), action);
        } catch (e) {
          if (!(e instanceof ArchonError) || e.status !== 401) throw e;
          await act(config, meta.id, await this.accessToken(meta.id, true), action);
        }
      });
    } catch (e) {
      if (!(e instanceof GrantLost)) throw e;
      const at = this.now().toISOString();
      await this.deps.store.markFailed(meta.id, at, 'Archon no longer accepts our grant', true);
      throw grantLostError();
    }
  }

  private async linked(id: string): Promise<{ meta: TournamentMeta; state: CachedTournament }> {
    const meta = await this.deps.store.getMeta(id);
    const state = meta && (await this.deps.store.getState(id));
    if (!meta || !state) throw new ApiError(404, 'not_found', 'No such tournament here');
    return { meta, state };
  }

  /**
   * A live access token for the tournament's grant, refreshed when it's (nearly) run out. Archon
   * rotates refresh tokens, so only the process holding the lease refreshes; others wait for it.
   */
  private async accessToken(id: string, force = false): Promise<string> {
    let seen: string | undefined;
    for (let attempt = 0; attempt < 10; attempt++) {
      const grant = await this.deps.store.getGrant(id);
      if (!grant) throw new GrantLost();
      // Forced (Archon refused the token we had): any token but that one will do.
      if (force && seen === undefined) seen = grant.access;
      const usable = (g: typeof grant) =>
        g.accessExpires * 1000 - EARLY_REFRESH_MS > this.now().getTime() &&
        !(force && g.access === seen);
      if (usable(grant)) return this.deps.sealer.open(grant.access, id);
      const now = this.now().getTime();
      if (!(await this.deps.store.takeLease(id, now, now + LEASE_MS))) {
        await this.sleep(500);
        continue;
      }
      // Another process may have refreshed between our read and the lease: read again, and
      // refresh only with the current refresh token.
      const current = await this.deps.store.getGrant(id);
      if (!current) throw new GrantLost();
      if (usable(current)) {
        await this.deps.store.releaseLease(id);
        return this.deps.sealer.open(current.access, id);
      }
      let tokens: Tokens;
      const spent = await this.deps.sealer.open(current.refresh, id);
      try {
        tokens = await refresh(await this.deps.config(), spent);
      } catch (e) {
        await this.deps.store.releaseLease(id);
        if (e instanceof ArchonError && !e.retryable) throw new GrantLost();
        throw e;
      }
      await this.deps.store.putTokens(id, {
        refresh: await this.deps.sealer.seal(tokens.refresh_token ?? spent, id),
        access: await this.deps.sealer.seal(tokens.access_token, id),
        accessExpires: Math.floor(this.now().getTime() / 1000) + tokens.expires_in,
      });
      return tokens.access_token;
    }
    throw new ArchonError(0, 'archon.busy', 'Archon’s grant is being renewed: try again shortly');
  }

  private async managed(identity: Identity, id: string): Promise<TournamentMeta> {
    requireTournamentAdmin(identity);
    const { meta, state } = await this.linked(id);
    if (!(await this.organises(identity, meta, state))) {
      throw new ApiError(
        403,
        'not_organiser',
        'Only its organisers in Archon can do that: link your Archon account if you are one',
      );
    }
    return meta;
  }

  /**
   * Whether a tournament admin organises the tournament in Archon: they are in its organisers
   * there (as last read), as the Archon account they linked here, or as the member who granted
   * the link, if they linked it.
   */
  private async organises(
    identity: Identity,
    meta: TournamentMeta,
    state: CachedTournament,
  ): Promise<boolean> {
    if (identity.kind !== 'user' || !identity.groups.includes(TOURNAMENT_ADMIN)) return false;
    const organisers = new Set(state.tournament.organizers_uids ?? []);
    if (meta.organiser === identity.sub && meta.organiserArchonUid) {
      if (organisers.has(meta.organiserArchonUid)) return true;
    }
    const link = await this.deps.archonStore.getLink(identity.sub);
    return !!link && organisers.has(link.archonUid);
  }

  private async summary(meta: TournamentMeta): Promise<TournamentSummary> {
    return {
      id: meta.id,
      name: meta.name,
      state: meta.state,
      format: meta.format,
      online: meta.online,
      start: meta.start,
      finish: meta.finish,
      timezone: meta.timezone,
      place: meta.place,
      players: meta.players,
      archonUrl: meta.archonUrl,
      organiser: (await this.deps.nameOf(meta.organiser)) ?? placeholderName(meta.organiser),
    };
  }

  private async details(
    identity: Identity,
    meta: TournamentMeta,
    state: CachedTournament,
  ): Promise<TournamentDetails> {
    const t = state.tournament;
    const members = new Map(state.members.map((m) => [m.uid, m]));
    const nameOf = (uid: string) =>
      members.get(uid)?.name ||
      t.players.find((p) => p.user_uid === uid)?.display_name ||
      'Unknown player';
    const base: TournamentDetails = {
      ...(await this.summary(meta)),
      description: t.description ?? null,
      roundTime: Math.round((t.round_time ?? 0) / 60),
      maxRounds: t.max_rounds ?? 0,
      multideck: !!t.multideck,
      officials: (t.organizers_uids ?? []).flatMap((u) => {
        const m = members.get(u);
        return m?.name ? [m.name] : [];
      }),
      winner: t.winner ? nameOf(t.winner) : null,
      updatedAt: meta.updatedAt,
      deckFormat: deckFormatOf(t),
      registrationOpen: registrationOpen(t),
    };
    if (identity.kind !== 'user') return base;
    const registrations = await this.deps.store.registrations(meta.id);
    const registered = new Set(registrations.filter((r) => !r.droppedAt).map((r) => r.archonUid));
    const owners = await this.deps.archonStore.owners(t.players.map((p) => p.user_uid));
    const accounts = new Map<string, string>();
    for (const [uid, sub] of owners) {
      accounts.set(uid, (await this.deps.nameOf(sub)) ?? placeholderName(sub));
    }
    const players: TournamentPlayer[] = t.players
      .map((p) => ({
        archonUid: p.user_uid,
        name: nameOf(p.user_uid),
        veknId: members.get(p.user_uid)?.vekn_id ?? null,
        state: p.state,
        gw: p.result?.gw ?? 0,
        vp: p.result?.vp ?? 0,
        tp: p.result?.tp ?? 0,
        missingDecklist: !!p.missing_decklist,
        account: accounts.get(p.user_uid) ?? null,
        registered: registered.has(p.user_uid),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const rounds: TournamentRound[] = t.rounds.map((tables, r) => ({
      number: r + 1,
      tables: tables.map((table, i) => ({
        number: i + 1,
        state: table.state,
        seats: table.seating.map((s) => ({
          archonUid: s.player_uid,
          name: nameOf(s.player_uid),
          vp: s.result?.vp ?? 0,
          gw: s.result?.gw ?? 0,
          tp: s.result?.tp ?? 0,
        })),
      })),
    }));
    const better = (a: TournamentStanding, b: TournamentStanding) =>
      a.gw > b.gw || (a.gw === b.gw && (a.vp > b.vp || (a.vp === b.vp && a.tp > b.tp)));
    const standings: TournamentStanding[] = (t.standings ?? []).map((s) => ({
      rank: 0,
      archonUid: s.user_uid,
      name: nameOf(s.user_uid),
      gw: s.gw,
      vp: s.vp,
      tp: s.tp,
      finalist: !!s.finalist,
      withdrawn: !!s.withdrawn,
      disqualified: !!s.disqualified,
    }));
    // Tied players share a rank (GW, then VP, then TP: VEKN tournament rules 3.1).
    for (const s of standings) s.rank = 1 + standings.filter((o) => better(o, s)).length;
    const manages = await this.organises(identity, meta, state);
    const link = await this.deps.archonStore.getLink(identity.sub);
    const mine = registrations.find((r) => r.sub === identity.sub);
    const archonUid = mine?.archonUid ?? link?.archonUid;
    const me: TournamentEntry = {
      archonLinked: !!link,
      veknId: link?.veknId ?? null,
      archonState: t.players.find((p) => p.user_uid === archonUid)?.state ?? null,
      registration: mine ? entryOf(mine) : null,
    };
    return {
      ...base,
      me,
      detail: { players, rounds, standings },
      ...(manages ? { manage: { grant: meta.grant, lastError: meta.lastError } } : {}),
    };
  }
}

function summaryOf(t: Tournament, config: ArchonConfig): TournamentSummaryFields {
  return {
    id: t.uid,
    name: t.name,
    state: t.state,
    format: t.format,
    online: !!t.online,
    start: t.start ?? null,
    finish: t.finish ?? null,
    timezone: t.timezone ?? null,
    place: t.online ? null : [t.venue, t.city, t.country].filter(Boolean).join(', ') || null,
    players: t.players.length,
    archonUrl: `${config.baseUrl}/tournaments/${t.uid}`,
  };
}

/** What we keep of a read: the fields we show, and members' names and VEKN numbers only. */
function cached(view: TournamentView): CachedTournament {
  const kept: Record<string, unknown> = {};
  for (const k of KEPT) if (k in view.tournament) kept[k] = view.tournament[k];
  return { tournament: kept as Tournament, members: [...view.members.values()] };
}

/** Players register here while Archon has registration or check-in open. */
function registrationOpen(t: Tournament): boolean {
  return t.state === 'Registration' || t.state === 'Waiting';
}

/**
 * Our deck format for Archon's: Standard and V5 (A8). Multi-deck tournaments (a deck per round)
 * and Limited come later.
 */
function deckFormatOf(t: Tournament): TournamentDetails['deckFormat'] {
  if (t.multideck) return null;
  const format = t.format.toLowerCase();
  return format === 'standard' || format === 'v5' ? format : null;
}

/** Archon's deck cards: `{<VEKN card id>: count}`. */
function archonCards(cards: DeckCards): Record<string, number> {
  const out: Record<string, number> = {};
  for (const { id, count } of [...cards.crypt, ...cards.library]) out[id] = (out[id] ?? 0) + count;
  return out;
}

function entryOf(reg: Registration): NonNullable<TournamentEntry['registration']> {
  return {
    deckId: reg.deck.id,
    deckName: reg.deck.name,
    deckVersion: reg.deck.version,
    registeredAt: reg.registeredAt,
    dropped: !!reg.droppedAt,
  };
}

function grantLostError() {
  return new ApiError(
    409,
    'grant_lost',
    'This tournament’s link to Archon has lapsed: its organiser needs to link it again',
  );
}

/** Managing tournaments is for the `tournament_admin` group only (docs/roles.md). */
function requireTournamentAdmin(identity: Identity) {
  const user = requireUser(identity);
  if (!user.groups.includes(TOURNAMENT_ADMIN)) {
    throw new ApiError(403, 'tournament_admin_only', 'Only tournament admins can do that');
  }
  return user;
}
