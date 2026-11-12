/**
 * Command console (GAME-13, architecture §4.2). Turns console text into the same `Command`s the
 * UI produces, resolved against the actor's own projected view so it can only name cards the actor
 * can see. Also provides completion data for the web and Mac consoles. Syntax: docs/console.md.
 */
import { type CardCatalog, normalizeName } from '../catalog.ts';
import type { Command } from '../commands.ts';
import {
  type CardInstance,
  type Counter,
  type GameState,
  PHASES,
  PLAYER_CALL_REASONS,
  type Ruling,
  STOP_ACTORS,
  type ZoneId,
  type ZoneName,
} from '../model.ts';
import { predator, prey, type SeatId } from '../seating.ts';
import { HIDDEN_ZONES, parseZoneId, zoneCards, zoneId } from '../zones.ts';

export interface ConsoleContext {
  /** The actor's projected view. */
  view: GameState;
  /** The actor's seat; undefined for judges and admins. */
  seat?: SeatId;
  catalog: CardCatalog;
}

export type ParseResult = { ok: true; command: Command } | { ok: false; error: string };

type Arg =
  | 'card'
  | 'zone'
  | 'seat'
  | 'amount'
  | 'count'
  | 'source'
  | 'options'
  | 'direction'
  | 'user'
  | 'outcome'
  | 'phases'
  | 'stops';

interface Syntax {
  args: Arg[];
  usage: string;
}

/** Every console command with its arguments; drives help text and completion. */
export const CONSOLE_COMMANDS: Record<string, Syntax> = {
  draw: { args: ['source', 'count'], usage: 'draw [crypt] [n]' },
  move: { args: ['card', 'zone', 'options'], usage: 'move <card> <zone> [top|bottom] [facedown]' },
  lock: { args: ['card'], usage: 'lock <card>' },
  unlock: { args: ['card'], usage: 'unlock <card>' },
  contest: { args: ['card'], usage: 'contest <card>' },
  uncontest: { args: ['card'], usage: 'uncontest <card>' },
  flip: { args: ['card'], usage: 'flip <card>' },
  blood: { args: ['amount', 'card'], usage: 'blood <±n> <card>' },
  life: { args: ['amount', 'card'], usage: 'life <±n> <card>' },
  counter: { args: ['amount', 'card'], usage: 'counter <±n> <card>' },
  transfer: { args: ['amount', 'card'], usage: 'transfer <±n> <card>' },
  pool: { args: ['amount', 'seat'], usage: 'pool <±n> [seat]' },
  vp: { args: ['amount', 'seat'], usage: 'vp <±n> [seat]' },
  shuffle: { args: ['zone'], usage: 'shuffle [zone]' },
  attach: { args: ['card', 'card'], usage: 'attach <card> <host>' },
  detach: { args: ['card'], usage: 'detach <card>' },
  reveal: { args: ['card'], usage: 'reveal <card>' },
  look: { args: ['card'], usage: 'look <card>  (judges)' },
  edge: { args: ['seat'], usage: 'edge <seat|none>' },
  direction: { args: ['direction'], usage: 'direction prey|predator' },
  next: { args: [], usage: 'next' },
  bleed: {
    args: ['card', 'seat', 'options'],
    usage: 'bleed <minion> [seat] [with <card>] [via <card>|override]',
  },
  hunt: { args: ['card', 'options'], usage: 'hunt <minion> [with <card>]' },
  political: { args: ['card', 'options'], usage: 'political <minion> [with <card>]' },
  equip: { args: ['card', 'options'], usage: 'equip <minion> with <card>' },
  recruit: { args: ['card', 'options'], usage: 'recruit <minion> with <card>' },
  employ: { args: ['card', 'options'], usage: 'employ <minion> with <card>' },
  action: { args: ['card', 'seat', 'options'], usage: 'action <minion> [seat] [with <card>]' },
  block: { args: ['card', 'options'], usage: 'block <minion> [via <card>|override]' },
  unblock: { args: [], usage: 'unblock  (withdraw your block attempt)' },
  pass: {
    args: ['options'],
    usage: 'pass [strikes|round]  (in combat: until the strikes, or the round’s end)',
  },
  maneuver: { args: ['options'], usage: 'maneuver long|close [via <card>]' },
  strike: {
    args: ['options'],
    usage:
      'strike hand [n] | <n>[R][A] | dodge | ends | steal <n> | other "text" | none  [first] [via <card>]  |  strike extra [via <card>]',
  },
  use: { args: ['card', 'options'], usage: 'use <card> ["what it does"]' },
  prevent: { args: ['count', 'options'], usage: 'prevent <n> [via <card>]' },
  press: { args: ['options'], usage: 'press continue|end [via <card>]' },
  hold: { args: [], usage: 'hold  (ask the open window to wait for you)' },
  pause: { args: ['count'], usage: 'pause [minutes]  (1–5, games with a table timer)' },
  resume: { args: [], usage: 'resume  (lift your pause early)' },
  endgame: { args: [], usage: 'endgame ["note"]  (admins: end the game, scored as a timeout)' },
  withdraw: { args: [], usage: 'withdraw  (your unlock phase, library empty, hand short)' },
  propose: { args: [], usage: 'propose  (casual games: propose ending the game early)' },
  agree: { args: [], usage: 'agree  (agree to end the game)' },
  decline: { args: [], usage: 'decline  (play on instead)' },
  play: {
    args: ['card', 'options'],
    usage: 'play <card> [ready] [on <host>] [noreplace]',
  },
  resolve: {
    args: ['outcome', 'count', 'options'],
    usage:
      'resolve success|failure [n] [edge]  |  resolve success ["terms"]  (political)  |  resolve combat <minion>',
  },
  vote: {
    args: ['options'],
    usage:
      'vote for|against <vampire> [n] | edge | card | <political card in hand> | other <n> [via <card>] ["note"]',
  },
  abstain: {
    args: ['options'],
    usage: 'abstain  (pass the rest of this referendum)  |  abstain <vampire> [via <card>]',
  },
  bloodhunt: { args: ['card'], usage: 'bloodhunt [<vampire>]  (as your action resolves)' },
  leavetorpor: { args: ['card'], usage: 'leavetorpor <vampire>  (a vampire of yours in torpor)' },
  diablerize: {
    args: ['options'],
    usage: 'diablerize [no]  (you blocked a vampire leaving torpor)',
  },
  endreferendum: { args: ['options'], usage: 'endreferendum pass|fail ["why"]' },
  endcombat: { args: [], usage: 'endcombat' },
  cancel: { args: [], usage: 'cancel  (cancel your action)' },
  autopass: {
    args: ['phases'],
    usage: 'autopass all|none|<phase>,...  (phase-end rounds you pass automatically)',
  },
  stop: {
    args: ['stops'],
    usage: 'stop none|neighbours|anyone  (block windows you never pass automatically)',
  },
  replace: { args: ['seat', 'user'], usage: 'replace <seat> <user>  (admins)' },
  call: {
    args: ['options'],
    usage: 'call slow-play|rules|dispute|other [seat] ["note"]  (call a judge)',
  },
  claim: { args: ['options'], usage: 'claim [call]  (judges: take a call; the oldest by default)' },
  rule: {
    args: ['options'],
    usage:
      'rule [call] answered|escalate|extend <seat> <hours>|passfor <seat>|time <minutes>|disqualify <seat> ["note"]  (judges)',
  },
};

const ZONE_ALIASES: Record<string, ZoneName> = {
  crypt: 'crypt',
  library: 'library',
  lib: 'library',
  hand: 'hand',
  uncontrolled: 'uncontrolled',
  unc: 'uncontrolled',
  ready: 'ready',
  torpor: 'torpor',
  ash: 'ashHeap',
  ashheap: 'ashHeap',
  removed: 'removed',
  rfg: 'removed',
  research: 'research',
};

class ParseError extends Error {}
const fail = (message: string): never => {
  throw new ParseError(message);
};

export function tokenize(input: string): string[] {
  return [...input.matchAll(/"([^"]*)"?|(\S+)/g)].map((m) => m[1] ?? m[2] ?? '');
}

export function parseConsole(input: string, ctx: ConsoleContext): ParseResult {
  try {
    return { ok: true, command: parse(tokenize(input.trim()), ctx) };
  } catch (e) {
    if (e instanceof ParseError) return { ok: false, error: e.message };
    throw e;
  }
}

function parse(tokens: string[], ctx: ConsoleContext): Command {
  const [name = '', ...args] = tokens;
  const verb = name.toLowerCase();
  const syntax = CONSOLE_COMMANDS[verb] ?? fail(`Unknown command "${name}"`);
  const usage = () => fail(`Usage: ${syntax.usage}`);
  const arg = (i: number) => args[i] ?? usage();
  const me = () => ctx.seat ?? fail('You have no seat at this table');
  const card = (i: number) => resolveCard(arg(i), ctx);
  /**
   * Splits `args` into leading positional tokens and keyword options: `with`/`via` take the next
   * token (its index is recorded), `override` takes none.
   */
  const options = (keywords: string[]) => {
    const at = new Map<string, number>();
    let positional = args.length;
    for (let i = 0; i < args.length; i++) {
      const k = (args[i] ?? '').toLowerCase();
      if (!keywords.includes(k)) {
        if (at.size) usage();
        continue;
      }
      if (positional === args.length) positional = i;
      if (at.has(k)) usage();
      if (k === 'override') at.set(k, i);
      else {
        if (i + 1 >= args.length) usage();
        at.set(k, ++i);
      }
    }
    return { positional, at };
  };
  const overrideClaim = (at: Map<string, number>) => {
    const via = at.get('via');
    if (via !== undefined) return { source: card(via).id };
    return at.has('override') ? {} : undefined;
  };
  const seatArg = (i: number) => (args[i] === undefined ? me() : resolveSeat(arg(i), ctx));
  const extra = (n: number) => {
    if (args.length > n) usage();
  };

  switch (verb) {
    case 'draw': {
      const from = args[0]?.toLowerCase() === 'crypt' ? 'crypt' : 'library';
      const rest = args.filter((a) => !['crypt', 'library'].includes(a.toLowerCase()));
      if (rest.length > 1) usage();
      const count = rest[0] === undefined ? 1 : integer(rest[0]);
      return { type: 'Draw', seat: me(), from, count };
    }
    case 'move': {
      const c = card(0);
      const to = resolveZone(arg(1), ctx, defaultSeatFor(c, arg(1)));
      const cmd: Command = { type: 'MoveCard', card: c.id, to };
      for (const opt of args.slice(2).map((a) => a.toLowerCase())) {
        if (opt === 'top' || opt === 'bottom') cmd.position = opt;
        else if (opt === 'facedown') cmd.faceDown = true;
        else if (opt === 'faceup') cmd.faceDown = false;
        else usage();
      }
      return cmd;
    }
    case 'lock':
    case 'unlock':
      extra(1);
      return { type: 'SetLocked', card: card(0).id, locked: verb === 'lock' };
    case 'contest':
    case 'uncontest':
      extra(1);
      return { type: 'SetContested', card: card(0).id, contested: verb === 'contest' };
    case 'flip':
      extra(1);
      return { type: 'Flip', card: card(0).id };
    case 'blood':
    case 'life':
    case 'counter': {
      extra(2);
      const delta = integer(arg(0));
      return {
        type: 'AdjustCounter',
        card: card(1).id,
        counter: (verb === 'counter' ? 'generic' : verb) as Counter,
        delta,
      };
    }
    case 'transfer': {
      extra(2);
      const amount = integer(arg(0));
      const c = card(1);
      const pool = { pool: me() };
      return amount >= 0
        ? { type: 'TransferBlood', from: pool, to: { card: c.id }, amount }
        : { type: 'TransferBlood', from: { card: c.id }, to: pool, amount: -amount };
    }
    case 'pool':
      extra(2);
      return { type: 'AdjustPool', seat: seatArg(1), delta: integer(arg(0)) };
    case 'vp': {
      extra(2);
      const delta = Number(arg(0));
      if (!/^[+-]?\d+(\.5)?$/.test(arg(0))) fail(`Not a number: ${arg(0)}`);
      return { type: 'AdjustVp', seat: seatArg(1), delta };
    }
    case 'shuffle':
      extra(1);
      return { type: 'Shuffle', zone: resolveZone(args[0] ?? 'library', ctx, me()) };
    case 'attach':
      extra(2);
      return { type: 'Attach', card: card(0).id, to: card(1).id };
    case 'detach':
      extra(1);
      return { type: 'Attach', card: card(0).id };
    case 'reveal':
      extra(1);
      return { type: 'Reveal', card: card(0).id };
    case 'look':
      extra(1);
      return { type: 'JudgeReveal', card: card(0).id };
    case 'edge': {
      extra(1);
      const target = arg(0);
      return target.toLowerCase() === 'none'
        ? { type: 'SetEdge' }
        : { type: 'SetEdge', seat: resolveSeat(target, ctx) };
    }
    case 'direction': {
      extra(1);
      const d = arg(0).toLowerCase();
      if (d !== 'prey' && d !== 'predator') usage();
      return { type: 'SetTurnDirection', direction: d === 'prey' ? 'toPrey' : 'toPredator' };
    }
    case 'next':
      extra(0);
      return { type: 'AdvancePhase' };
    case 'replace':
      extra(2);
      return { type: 'ReplacePlayer', seat: resolveSeat(arg(0), ctx), user: arg(1) };
    case 'bleed':
    case 'hunt':
    case 'political':
    case 'equip':
    case 'recruit':
    case 'employ':
    case 'action': {
      const kind = verb === 'action' ? 'other' : verb;
      const opts = options(verb === 'bleed' ? ['with', 'via', 'override'] : ['with']);
      const directed = verb === 'bleed' || verb === 'action';
      if (opts.positional < 1 || opts.positional > (directed ? 2 : 1)) usage();
      const cmd: Command = { type: 'DeclareAction', kind, minion: card(0).id };
      if (opts.positional > 1) cmd.target = resolveSeat(arg(1), ctx);
      const withAt = opts.at.get('with');
      if (withAt !== undefined) cmd.card = card(withAt).id;
      else if (['equip', 'recruit', 'employ'].includes(verb)) usage();
      const override = overrideClaim(opts.at);
      if (override) cmd.override = override;
      return cmd;
    }
    case 'block': {
      const opts = options(['via', 'override']);
      if (opts.positional !== 1) usage();
      const cmd: Command = { type: 'Block', minion: card(0).id };
      const override = overrideClaim(opts.at);
      if (override) cmd.override = override;
      return cmd;
    }
    case 'unblock':
      extra(0);
      return { type: 'WithdrawBlock' };
    case 'pass': {
      extra(1);
      const until = args[0]?.toLowerCase();
      if (until === undefined) return { type: 'Pass' };
      if (until === 'strikes') return { type: 'PassUntil', until: 'strikes' };
      if (until === 'round') return { type: 'PassUntil', until: 'end' };
      return usage();
    }
    case 'maneuver': {
      const opts = options(['via']);
      if (opts.positional !== 1) usage();
      const t = arg(0).toLowerCase();
      const to = t === 'long' || t === 'close' ? t : usage();
      const via = opts.at.get('via');
      return via === undefined
        ? { type: 'Maneuver', to }
        : { type: 'Maneuver', to, source: card(via).id };
    }
    case 'prevent': {
      const opts = options(['via']);
      if (opts.positional !== 1) usage();
      const cmd: Command = { type: 'Prevent', points: integer(arg(0)) };
      const via = opts.at.get('via');
      if (via !== undefined) cmd.source = card(via).id;
      return cmd;
    }
    case 'press': {
      const opts = options(['via']);
      if (opts.positional !== 1) usage();
      const m = arg(0).toLowerCase();
      const mode = m === 'continue' || m === 'end' ? m : usage();
      const via = opts.at.get('via');
      return via === undefined
        ? { type: 'Press', mode }
        : { type: 'Press', mode, source: card(via).id };
    }
    case 'strike': {
      const opts = options(['via']);
      if (args[0]?.toLowerCase() === 'extra') {
        if (opts.positional !== 1) usage();
        const via = opts.at.get('via');
        return via === undefined
          ? { type: 'AdditionalStrike' }
          : { type: 'AdditionalStrike', source: card(via).id };
      }
      const words = args.slice(0, opts.positional);
      const first = words.some((w) => w.toLowerCase() === 'first');
      const [what = '', ...rest] = words.filter((w) => w.toLowerCase() !== 'first');
      const cmd: Extract<Command, { type: 'Strike' }> = { type: 'Strike', kind: 'none' };
      const w = what.toLowerCase();
      const damage = /^(\d+)(r?)(a?)$/i.exec(what) ?? /^(\d+)(a?)(r?)$/i.exec(what);
      if (w === 'hand') {
        cmd.kind = 'hand';
        if (rest.length > 1) usage();
        cmd.amount = rest[0] === undefined ? 1 : integer(rest[0]);
      } else if (damage) {
        if (rest.length) usage();
        cmd.kind = 'damage';
        cmd.amount = Number(damage[1]);
        const flags = what.slice((damage[1] ?? '').length).toLowerCase();
        if (flags.includes('r')) cmd.ranged = true;
        if (flags.includes('a')) cmd.aggravated = true;
      } else if (w === 'dodge' || w === 'ends' || w === 'none') {
        if (rest.length) usage();
        cmd.kind = w === 'ends' ? 'combat-ends' : w;
      } else if (w === 'steal') {
        if (rest.length !== 1) usage();
        cmd.kind = 'steal-blood';
        cmd.amount = integer(rest[0] ?? '');
      } else if (w === 'other') {
        const note = rest.join(' ').trim();
        if (!note) usage();
        cmd.kind = 'other';
        cmd.note = note;
      } else usage();
      if (first) cmd.first = true;
      const via = opts.at.get('via');
      if (via !== undefined) cmd.source = card(via).id;
      return cmd;
    }
    case 'use': {
      const c = card(0);
      const note = args.slice(1).join(' ').trim();
      return note ? { type: 'UseCard', card: c.id, note } : { type: 'UseCard', card: c.id };
    }
    case 'hold':
      extra(0);
      return { type: 'Hold' };
    case 'pause':
      extra(1);
      return { type: 'Pause', minutes: args[0] === undefined ? 5 : integer(args[0]) };
    case 'resume':
      extra(0);
      return { type: 'Resume' };
    case 'endgame': {
      const note = args.join(' ').trim();
      return note ? { type: 'EndGame', note } : { type: 'EndGame' };
    }
    case 'withdraw':
      extra(0);
      return { type: 'Withdraw' };
    case 'propose':
      extra(0);
      return { type: 'ProposeEnd' };
    case 'agree':
      extra(0);
      return { type: 'AgreeEnd' };
    case 'decline':
      extra(0);
      return { type: 'DeclineEnd' };
    case 'call': {
      const [reason = '', ...rest] = args;
      if (!(PLAYER_CALL_REASONS as readonly string[]).includes(reason)) usage();
      const cmd: Command = {
        type: 'CallJudge',
        reason: reason as (typeof PLAYER_CALL_REASONS)[number],
      };
      let i = 0;
      if (rest[0] !== undefined && ctx.view.seats.some((x) => x.id === rest[0]?.toUpperCase())) {
        cmd.seat = resolveSeat(rest[0], ctx);
        i = 1;
      }
      const note = rest.slice(i).join(' ').trim();
      if (note) cmd.note = note;
      return cmd;
    }
    case 'claim':
    case 'rule': {
      const calls = ctx.view.judgeCalls ?? [];
      let rest = args;
      let id = calls[0]?.id;
      if (rest[0] && /^c\d+$/.test(rest[0])) {
        id = rest[0];
        rest = rest.slice(1);
      }
      if (!id) fail('There is no open judge call');
      if (verb === 'claim') {
        if (rest.length) usage();
        return { type: 'ClaimJudgeCall', id: id as string };
      }
      const [kind = '', ...more] = rest;
      let ruling: Ruling;
      let used = 0;
      switch (kind) {
        case 'answered':
          ruling = { kind: 'answered' };
          break;
        case 'escalate':
          ruling = { kind: 'escalate' };
          break;
        case 'extend':
          ruling = {
            kind: 'extend-deadline',
            seat: resolveSeat(more[0] ?? '', ctx),
            hours: integer(more[1] ?? ''),
          };
          used = 2;
          break;
        case 'passfor':
          ruling = { kind: 'pass-for', seat: resolveSeat(more[0] ?? '', ctx) };
          used = 1;
          break;
        case 'time':
          ruling = { kind: 'extend-time', minutes: integer(more[0] ?? '') };
          used = 1;
          break;
        case 'disqualify':
          ruling = { kind: 'disqualify', seat: resolveSeat(more[0] ?? '', ctx) };
          used = 1;
          break;
        default:
          return usage();
      }
      const note = more.slice(used).join(' ').trim();
      return { type: 'ResolveJudgeCall', id: id as string, ruling, ...(note ? { note } : {}) };
    }
    case 'stop': {
      extra(1);
      const t = arg(0).toLowerCase();
      if (t === 'none') return { type: 'SetStops', stops: [] };
      const actors =
        STOP_ACTORS.find((x) => x === t) ?? fail(`Use none, ${STOP_ACTORS.join(' or ')}`);
      return { type: 'SetStops', stops: [{ on: 'block-window', actors }] };
    }
    case 'play': {
      const cmd: Command = { type: 'PlayCard', card: card(0).id };
      for (let i = 1; i < args.length; i++) {
        const opt = args[i]?.toLowerCase();
        if (opt === 'ready') cmd.to = 'ready';
        else if (opt === 'noreplace') cmd.replace = false;
        else if (opt === 'on') cmd.attachTo = card(++i).id;
        else usage();
      }
      return cmd;
    }
    case 'resolve': {
      const outcome = arg(0).toLowerCase();
      if (outcome === 'combat') {
        extra(2);
        return { type: 'ResolveAction', outcome: 'combat', opponent: card(1).id };
      }
      if (outcome !== 'success' && outcome !== 'failure') usage();
      const cmd: Extract<Command, { type: 'ResolveAction' }> = {
        type: 'ResolveAction',
        outcome: outcome === 'success' ? 'success' : 'failure',
      };
      const terms: string[] = [];
      for (const opt of args.slice(1)) {
        if (opt.toLowerCase() === 'edge') cmd.edge = true;
        else if (/^[+-]?\d+$/.test(opt)) cmd.amount = integer(opt);
        // Anything else is the terms of a political action's referendum (M6.5).
        else if (outcome === 'success') terms.push(opt);
        else usage();
      }
      if (terms.length) cmd.terms = terms.join(' ');
      return cmd;
    }
    case 'vote':
      return voteCommand(args, ctx, usage);
    case 'abstain': {
      if (!args.length) return { type: 'Abstain' };
      // Make a vampire abstain: its votes are cancelled (Kateline Nadasdy, Demonstration).
      const opts = options(['via']);
      if (opts.positional !== 1) usage();
      const via = opts.at.get('via');
      const minion = card(0).id;
      return via === undefined
        ? { type: 'CancelVotes', minion }
        : { type: 'CancelVotes', minion, source: card(via).id };
    }
    case 'leavetorpor':
      extra(1);
      if (!args.length) usage();
      return { type: 'DeclareAction', kind: 'leave-torpor', minion: card(0).id };
    case 'diablerize': {
      extra(1);
      const answer = args[0]?.toLowerCase();
      if (answer === undefined) return { type: 'Diablerize' };
      if (answer === 'no') return { type: 'Diablerize', decline: true };
      return usage();
    }
    case 'bloodhunt':
      extra(1);
      return args.length
        ? { type: 'CallBloodHunt', minion: card(0).id }
        : { type: 'CallBloodHunt' };
    case 'endreferendum': {
      const result = arg(0).toLowerCase();
      if (result !== 'pass' && result !== 'fail') usage();
      const note = args.slice(1).join(' ').trim();
      const cmd: Command = { type: 'EndReferendum', passed: result === 'pass' };
      return note ? { ...cmd, note } : cmd;
    }
    case 'endcombat':
      extra(0);
      return { type: 'EndCombat' };
    case 'cancel':
      extra(0);
      return { type: 'CancelAction' };
    case 'autopass': {
      extra(1);
      const t = arg(0).toLowerCase();
      if (t === 'all') return { type: 'SetAutoPass', phases: [...PHASES] };
      if (t === 'none') return { type: 'SetAutoPass', phases: [] };
      const phases = t
        .split(',')
        .map((p) => PHASES.find((x) => x === p) ?? fail(`No phase "${p}" (${PHASES.join(', ')})`));
      return { type: 'SetAutoPass', phases };
    }
    default:
      return fail(`Unknown command "${name}"`);
  }
}

/**
 * `vote for|against <source> [n] [via <card>] ["note"]` (docs/console.md): the source is `edge`,
 * `card` (the calling card's vote), `other`, or a card: a minion in a ready region votes; a
 * political action card in the hand is burned; any other card grants `n` votes.
 */
function voteCommand(args: string[], ctx: ConsoleContext, usage: () => never): Command {
  const side = (args[0] ?? '').toLowerCase();
  if (side !== 'for' && side !== 'against') usage();
  const what = args[1] ?? usage();
  const cmd: Extract<Command, { type: 'CastVotes' }> = {
    type: 'CastVotes',
    side: side === 'for' ? 'for' : 'against',
    source: 'other',
  };
  const notes: string[] = [];
  for (let i = 2; i < args.length; i++) {
    const t = args[i] ?? '';
    if (/^\d+$/.test(t) && cmd.votes === undefined && !notes.length) cmd.votes = integer(t);
    else if (t.toLowerCase() === 'via' && cmd.card === undefined && !notes.length) {
      cmd.card = resolveCard(args[++i] ?? usage(), ctx).id;
    } else notes.push(t);
  }
  const w = what.toLowerCase();
  if (w === 'edge' || w === 'card') {
    if (cmd.card !== undefined || notes.length) usage();
    cmd.source = w;
  } else if (w === 'other') {
    if (cmd.votes === undefined) fail('How many votes? vote for other <n> [via <card>]');
  } else {
    if (cmd.card !== undefined) usage();
    const c = resolveCard(what, ctx);
    const info = c.cardId === undefined ? undefined : ctx.catalog.get(c.cardId);
    const { name } = parseZoneId(c.zone);
    const minion =
      name === 'ready' &&
      c.attachedTo === undefined &&
      (info?.kind === 'crypt' || !!info?.types?.includes('Ally'));
    if (minion) cmd.source = 'minion';
    if (minion) cmd.minion = c.id;
    else if (name === 'hand' && info?.types?.includes('Political Action')) {
      if (cmd.votes !== undefined) usage();
      cmd.source = 'burned';
      cmd.card = c.id;
    } else {
      if (cmd.votes === undefined) fail(`How many votes does ${info?.name ?? 'it'} give?`);
      cmd.card = c.id;
    }
  }
  if (notes.length) cmd.note = notes.join(' ');
  return cmd;
}

function integer(token: string): number {
  if (!/^[+-]?\d+$/.test(token)) fail(`Not a whole number: ${token}`);
  return Number(token);
}

/** Cards go back to their owner's hidden zones, ash heap and removal; in-play moves keep the controller. */
function defaultSeatFor(card: CardInstance, zoneToken: string): SeatId {
  const name = ZONE_ALIASES[zoneToken.toLowerCase()];
  if (name && (HIDDEN_ZONES.has(name) || name === 'ashHeap' || name === 'removed'))
    return card.owner;
  return card.controller;
}

export function resolveSeat(token: string, ctx: ConsoleContext): SeatId {
  const t = token.toLowerCase();
  const seats = ctx.view.seats;
  if (t === 'me') return ctx.seat ?? fail('You have no seat at this table');
  if (t === 'prey' || t === 'predator') {
    const me = ctx.seat ?? fail('You have no seat at this table');
    const refs = seats.map((s) => ({ id: s.id, ousted: !!(s.ousted || s.withdrawn) }));
    return (t === 'prey' ? prey(refs, me) : predator(refs, me)) ?? fail(`You have no ${t}`);
  }
  const seat =
    seats.find((s) => s.id.toLowerCase() === t) ??
    seats.find((s) => s.occupant.toLowerCase() === t) ??
    fail(`No seat "${token}"`);
  return seat.id;
}

/** `zone` or `seat:zone`. */
export function resolveZone(
  token: string,
  ctx: ConsoleContext,
  defaultSeat: SeatId | undefined,
): ZoneId {
  const i = token.lastIndexOf(':');
  const zoneToken = i < 0 ? token : token.slice(i + 1);
  const name = ZONE_ALIASES[zoneToken.toLowerCase()] ?? fail(`No zone "${zoneToken}"`);
  const seat =
    i < 0
      ? (defaultSeat ?? fail('Which seat? Use seat:zone'))
      : resolveSeat(token.slice(0, i), ctx);
  return zoneId(seat, name);
}

/**
 * A card reference: `#id` (or a unique ID prefix), `[seat:]zone:n` (1-based position, top first),
 * or a card name (accent/case-insensitive; exact match, then prefix, then substring). Names only
 * match cards the actor can see; copies of the same card in the same zone are interchangeable.
 */
export function resolveCard(token: string, ctx: ConsoleContext): CardInstance {
  // Zone order (seat by seat, top card first), so name matches resolve deterministically.
  const cards = Object.values(ctx.view.zones)
    .flat()
    .flatMap((id) => ctx.view.cards[id] ?? []);
  if (token.startsWith('#')) {
    const prefix = token.slice(1).toLowerCase();
    const exact = ctx.view.cards[prefix];
    if (exact) return exact;
    const matches = cards.filter((c) => c.id.startsWith(prefix));
    if (matches.length === 1 && matches[0]) return matches[0];
    return fail(matches.length ? `Ambiguous card ID ${token}` : `No card ${token}`);
  }
  const pos = /^(.*):(\d+)$/.exec(token);
  if (pos?.[1] && pos[2]) {
    const zone = resolveZone(pos[1], ctx, ctx.seat);
    const id = zoneCards(ctx.view, zone)[Number(pos[2]) - 1] ?? fail(`No card at ${token}`);
    return ctx.view.cards[id] ?? fail(`No card at ${token}`);
  }
  const q = normalizeName(token);
  if (!q) fail('Which card?');
  const named = cards.flatMap((c) => {
    const name = c.cardId && ctx.catalog.get(c.cardId)?.name;
    return name ? [{ card: c, name: normalizeName(name) }] : [];
  });
  const tiers = [
    named.filter((n) => n.name === q),
    named.filter((n) => n.name.startsWith(q)),
    named.filter((n) => n.name.includes(q)),
  ];
  const found = (tiers.find((t) => t.length > 0) ?? []).map((n) => n.card);
  if (found.length === 0) fail(`No visible card matches "${token}"`);
  const mine = found.filter(
    (c) => c.controller === ctx.seat || parseZoneId(c.zone).seat === ctx.seat,
  );
  const pool = mine.length > 0 ? mine : found;
  const groups = new Map<string, CardInstance>();
  for (const c of pool) {
    const key = `${c.cardId}|${c.zone}|${c.locked}|${JSON.stringify(c.counters)}|${c.attachedTo ?? ''}`;
    if (!groups.has(key)) groups.set(key, c);
  }
  if (groups.size > 1) {
    const options = [...groups.values()].map((c) => `#${c.id} (${c.zone})`).join(', ');
    fail(`"${token}" matches several cards: ${options}`);
  }
  return pool[0] as CardInstance;
}

/** Completions for the last token of `input` (which may be empty after a trailing space). */
export function completeConsole(input: string, ctx: ConsoleContext): string[] {
  const tokens = tokenize(input);
  if (input === '' || /\s$/.test(input)) tokens.push('');
  const last = tokens[tokens.length - 1] ?? '';
  const prefix = last.toLowerCase();
  const match = (options: Iterable<string>) =>
    [...new Set(options)]
      .filter((o) => o.toLowerCase().replace(/^"/, '').startsWith(prefix))
      .sort();
  if (tokens.length <= 1) return match(Object.keys(CONSOLE_COMMANDS));
  const syntax = CONSOLE_COMMANDS[tokens[0]?.toLowerCase() ?? ''];
  const kind = syntax?.args[Math.min(tokens.length - 2, syntax.args.length - 1)];
  const seats = () => [...ctx.view.seats.map((s) => s.id), 'me', 'prey', 'predator'];
  switch (kind) {
    case 'card':
      return match(visibleNames(ctx).map((n) => (/\s/.test(n) ? `"${n}"` : n)));
    case 'zone':
      return match(Object.keys(ZONE_ALIASES));
    case 'seat':
      return match(tokens[0]?.toLowerCase() === 'edge' ? [...seats(), 'none'] : seats());
    case 'source':
      return match(['crypt']);
    case 'options': {
      const verb = tokens[0]?.toLowerCase() ?? '';
      if (verb === 'play') return match(['ready', 'on', 'noreplace']);
      if (verb === 'resolve') return match(['edge']);
      if (verb === 'move') return match(['top', 'bottom', 'facedown', 'faceup']);
      if (verb === 'bleed') return match(['with', 'via', 'override']);
      if (verb === 'block') return match(['via', 'override']);
      if (verb === 'pass') return match(['strikes', 'round']);
      if (verb === 'maneuver') return match(['long', 'close', 'via']);
      if (verb === 'strike')
        return match(['hand', 'dodge', 'ends', 'steal', 'other', 'none', 'first', 'extra', 'via']);
      if (verb === 'press') return match(['continue', 'end', 'via']);
      if (verb === 'prevent') return match(['via']);
      if (verb === 'use') return [];
      return match(['with']);
    }
    case 'outcome':
      return match(['success', 'failure', 'combat']);
    case 'phases':
      return match(['all', 'none', ...PHASES]);
    case 'stops':
      return match(['none', ...STOP_ACTORS]);
    case 'direction':
      return match(['prey', 'predator']);
    default:
      return [];
  }
}

function visibleNames(ctx: ConsoleContext): string[] {
  return Object.values(ctx.view.cards).flatMap((c) => {
    const name = c.cardId && ctx.catalog.get(c.cardId)?.name;
    return name ? [name] : [];
  });
}
