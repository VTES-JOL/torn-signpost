/**
 * Golden-scenario runner (architecture §11). Scenarios are plain-text scripts in console syntax,
 * so the same files can be run by the TypeScript tests and, later, by the Swift client through
 * JavaScriptCore. Format: docs/console.md#scenarios.
 */
import { type CardCatalog, normalizeName } from './catalog.ts';
import {
  type ConsoleContext,
  parseConsole,
  resolveCard,
  resolveSeat,
  tokenize,
} from './console/index.ts';
import { decide } from './decide.ts';
import { describeEvent } from './describe.ts';
import type { GameEvent } from './events.ts';
import { evolve, newGame } from './evolve.ts';
import type { Actor, CardId, Format, GameState, Viewer } from './model.ts';
import { project, projectEvent } from './projection.ts';
import { seededRng } from './rng.ts';
import type { SeatId } from './seating.ts';
import { zoneCards } from './zones.ts';

export interface ScenarioFailure {
  line: number;
  text: string;
  message: string;
}

export interface ScenarioRun {
  state: GameState;
  events: GameEvent[];
  failure?: ScenarioFailure;
}

const NOW = '2026-01-01T00:00:00.000Z';

export function runScenario(source: string, catalog: CardCatalog): ScenarioRun {
  let rng = seededRng(1);
  let format: Format = 'standard';
  let tournament = false;
  const seats: { id: SeatId; user: string; crypt: CardId[]; library: CardId[] }[] = [];
  let state = newGame('scenario');
  const events: GameEvent[] = [];
  let lastEvents: { ev: GameEvent; before: GameState; after: GameState }[] = [];

  const lines = source.split('\n');
  for (const [i, raw] of lines.entries()) {
    const text = raw.trim();
    if (!text || text.startsWith('#')) continue;
    const fail = (message: string): ScenarioRun => ({
      state,
      events,
      failure: { line: i + 1, text, message },
    });
    const [head = '', ...rest] = tokenize(text);

    try {
      const command = /^(reject(?::([\w-]+))?\s+)?(\w+)>\s*(.*)$/.exec(text);
      if (command) {
        const [, isReject, code, who = '', input = ''] = command;
        const { actor, viewer, seat } = actorFor(state, who);
        const view = project(state, viewer);
        const ctx: ConsoleContext = { view, catalog, ...(seat ? { seat } : {}) };
        const parsed = parseConsole(input, ctx);
        const result = parsed.ok
          ? decide(state, parsed.command, { actor, now: NOW, rng, catalog })
          : undefined;
        if (isReject) {
          if (result?.ok) return fail('Expected the command to be rejected, but it succeeded');
          if (code && result?.rejection.code !== code) {
            return fail(
              `Expected rejection "${code}", got ${result ? `"${result.rejection.code}"` : `parse error: ${parsed.ok ? '' : parsed.error}`}`,
            );
          }
          continue;
        }
        if (!parsed.ok) return fail(`Parse error: ${parsed.error}`);
        if (!result?.ok)
          return fail(`Rejected (${result?.rejection.code}): ${result?.rejection.message}`);
        lastEvents = [];
        for (const ev of result.events) {
          const before = state;
          state = evolve(state, ev);
          lastEvents.push({ ev, before, after: state });
          events.push(ev);
        }
        continue;
      }

      switch (head) {
        case 'seed':
          rng = seededRng(Number(rest[0]));
          break;
        case 'format':
          format = rest[0] as Format;
          break;
        case 'tournament':
          tournament = true;
          break;
        case 'seat':
          seats.push({ id: rest[0] ?? '', user: rest[1] ?? '', crypt: [], library: [] });
          break;
        case 'crypt':
        case 'library': {
          const seat = seats.find((s) => s.id === rest[0]);
          if (!seat) return fail(`Unknown seat ${rest[0]}`);
          seat[head].push(...deckList(rest.slice(1), catalog));
          break;
        }
        case 'start': {
          const result = decide(
            state,
            { type: 'StartGame', gameId: 'scenario', format, seats, settings: { tournament } },
            { actor: { kind: 'system' }, now: NOW, rng, catalog },
          );
          if (!result.ok) return fail(`Rejected: ${result.rejection.message}`);
          for (const ev of result.events) {
            state = evolve(state, ev);
            events.push(ev);
          }
          break;
        }
        case 'expect': {
          const message = check(state, rest, catalog);
          if (message) return fail(message);
          break;
        }
        case 'log': {
          const [who = '', ...words] = rest;
          const expected = words.join(' ');
          const viewer = viewerToken(state, who);
          const lines = lastEvents.map(({ ev, before, after }) =>
            describeEvent(projectEvent(before, after, ev, viewer), project(before, viewer), {
              catalog,
            }),
          );
          if (!lines.includes(expected)) return fail(`Log for ${who} was: ${lines.join(' | ')}`);
          break;
        }
        default:
          return fail(`Unknown directive "${head}"`);
      }
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  }
  return { state, events };
}

function deckList(tokens: string[], catalog: CardCatalog): CardId[] {
  const out: CardId[] = [];
  for (const token of tokens) {
    const times = /^\*(\d+)$/.exec(token);
    if (times) {
      const last = out[out.length - 1];
      if (last === undefined) throw new Error('Multiplier without a card');
      for (let n = 1; n < Number(times[1]); n++) out.push(last);
      continue;
    }
    const card = catalog.all().find((c) => normalizeName(c.name) === normalizeName(token));
    if (!card) throw new Error(`Unknown card "${token}"`);
    out.push(card.id);
  }
  return out;
}

function actorFor(state: GameState, who: string): { actor: Actor; viewer: Viewer; seat?: SeatId } {
  if (who === 'judge')
    return { actor: { kind: 'judge', user: 'judge' }, viewer: { kind: 'judge' } };
  if (who === 'admin')
    return { actor: { kind: 'admin', user: 'admin' }, viewer: { kind: 'spectator' } };
  const seat = state.seats.find((s) => s.id === who);
  if (!seat) throw new Error(`Unknown actor ${who}`);
  return {
    actor: { kind: 'player', user: seat.occupant },
    viewer: { kind: 'player', seat: seat.id },
    seat: seat.id,
  };
}

function viewerToken(state: GameState, who: string): Viewer {
  if (who === 'judge') return { kind: 'judge' };
  if (who === 'public' || who === 'spectator') return { kind: 'spectator' };
  if (!state.seats.some((s) => s.id === who)) throw new Error(`Unknown viewer ${who}`);
  return { kind: 'player', seat: who };
}

/** One `expect` line; returns a failure message or undefined. */
function check(state: GameState, args: string[], catalog: CardCatalog): string | undefined {
  const [what = '', ...rest] = args;
  const ctx: ConsoleContext = { view: state, catalog };
  const seat = (token: string | undefined) =>
    state.seats.find((s) => s.id === resolveSeat(token ?? '', ctx));
  const same = (label: string, actual: unknown, expected: string) =>
    String(actual) === expected
      ? undefined
      : `Expected ${label} to be ${expected}, got ${String(actual)}`;

  switch (what) {
    case 'pool':
      return same(`${rest[0]} pool`, seat(rest[0])?.pool, rest[1] ?? '');
    case 'vp':
      return same(`${rest[0]} VP`, seat(rest[0])?.vp, rest[1] ?? '');
    case 'edge':
      return same('Edge', state.seats.find((s) => s.hasEdge)?.id ?? 'none', rest[0] ?? '');
    case 'direction':
      return same(
        'direction',
        state.turnDirection === 'toPrey' ? 'prey' : 'predator',
        rest[0] ?? '',
      );
    case 'occupant':
      return same(`${rest[0]} occupant`, seat(rest[0])?.occupant, rest[1] ?? '');
    case 'turn': {
      const t = state.turn;
      return same('turn', t ? `${t.number} ${t.seat} ${t.phase}` : 'none', rest.join(' '));
    }
    case 'count':
      return same(`${rest[0]} count`, zoneCards(state, rest[0] as never).length, rest[1] ?? '');
    case 'sees': {
      const [who = '', zone = '', n = ''] = rest;
      const view = project(state, viewerToken(state, who));
      const visible = zoneCards(view, zone as never).filter((id) => view.cards[id]?.cardId).length;
      return same(`cards ${who} sees in ${zone}`, visible, n);
    }
    case 'card': {
      const [ref = '', prop = '', ...words] = rest;
      const expected = words.join(' ');
      const card = resolveCard(ref, ctx);
      const name = (id: string | undefined) => {
        const cardId = id && state.cards[id]?.cardId;
        return (cardId && catalog.get(cardId)?.name) || 'none';
      };
      const props: Record<string, unknown> = {
        zone: card.zone,
        controller: card.controller,
        owner: card.owner,
        locked: card.locked,
        faceDown: card.faceDown,
        contested: card.contested,
        blood: card.counters.blood ?? 0,
        life: card.counters.life ?? 0,
        generic: card.counters.generic ?? 0,
        attached: name(card.attachedTo),
      };
      if (!(prop in props)) return `Unknown card property "${prop}"`;
      return same(`${ref} ${prop}`, props[prop], expected);
    }
    default:
      return `Unknown expectation "${what}"`;
  }
}
