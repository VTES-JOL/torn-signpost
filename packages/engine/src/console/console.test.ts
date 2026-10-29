import { describe, expect, it } from 'vitest';
import { decide } from '../decide.ts';
import { evolve, newGame } from '../evolve.ts';
import type { GameState } from '../model.ts';
import { project } from '../projection.ts';
import { seededRng } from '../rng.ts';
import { testCatalog as catalog } from '../testing/fixtures.ts';
import { type ConsoleContext, completeConsole, parseConsole, tokenize } from './index.ts';

const rng = seededRng(5);
function game(): GameState {
  const seat = (id: string, crypt: string, library: string) => ({
    id,
    user: id.toLowerCase(),
    crypt: Array(12).fill(crypt),
    library: Array(20).fill(library),
  });
  let state = newGame('g');
  const apply = (r: ReturnType<typeof decide>) => {
    if (!r.ok) throw new Error(r.rejection.message);
    state = r.events.reduce(evolve, state);
  };
  apply(
    decide(
      state,
      {
        type: 'StartGame',
        gameId: 'g',
        format: 'standard',
        seats: [
          seat('A', 't-ilse', 't-ward'),
          seat('B', 't-tomas', 't-feed'),
          seat('C', 't-tomas', 't-feed'),
        ],
      },
      { actor: { kind: 'system' }, now: 't', rng, catalog },
    ),
  );
  const ctx = { actor: { kind: 'player', user: 'a' } as const, now: 't', rng, catalog };
  apply(decide(state, { type: 'Draw', seat: 'A', from: 'crypt', count: 2 }, ctx));
  apply(decide(state, { type: 'Draw', seat: 'A', count: 3 }, ctx));
  const unc = state.zones['A:uncontrolled']?.[0] ?? '';
  apply(decide(state, { type: 'MoveCard', card: unc, to: 'A:ready' }, ctx));
  return state;
}

const state = game();
const asA: ConsoleContext = {
  view: project(state, { kind: 'player', seat: 'A' }),
  seat: 'A',
  catalog,
};
const asB: ConsoleContext = {
  view: project(state, { kind: 'player', seat: 'B' }),
  seat: 'B',
  catalog,
};
const parse = (input: string, ctx = asA) => parseConsole(input, ctx);

describe('tokenize', () => {
  it('keeps quoted names together', () => {
    expect(tokenize('move "Ilse Várga" torpor')).toEqual(['move', 'Ilse Várga', 'torpor']);
  });
});

describe('parseConsole', () => {
  it('matches names ignoring case and accents, among cards the actor can see', () => {
    // B can only see A's vampire in play, not the one in A's uncontrolled region.
    const r = parse('blood +2 "ILSE VARGA"', asB);
    expect(r).toMatchObject({
      ok: true,
      command: { type: 'AdjustCounter', counter: 'blood', delta: 2 },
    });
    if (r.ok && r.command.type === 'AdjustCounter') {
      expect(state.cards[r.command.card]?.zone).toBe('A:ready');
    }
  });

  it('reports ambiguity between different copies', () => {
    const r = parse('blood +1 ilse');
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.error).toMatch(/matches several cards/);
  });

  it('cannot name cards the actor cannot see', () => {
    expect(parse('lock "Iron Ward"', asB)).toMatchObject({ ok: false });
    expect(parse('reveal "Iron Ward"')).toMatchObject({ ok: true, command: { type: 'Reveal' } });
  });

  it('resolves positions, seats and zone defaults', () => {
    expect(parse('move hand:1 ready facedown')).toMatchObject({
      ok: true,
      command: { type: 'MoveCard', to: 'A:ready', faceDown: true },
    });
    expect(parse('move A:ready:1 ash')).toMatchObject({ ok: true, command: { to: 'A:ashHeap' } });
    expect(parse('pool -1 prey')).toEqual({
      ok: true,
      command: { type: 'AdjustPool', seat: 'B', delta: -1 },
    });
    expect(parse('pool -1 predator')).toMatchObject({ command: { seat: 'C' } });
    expect(parse('transfer -1 A:ready:1')).toMatchObject({
      command: { type: 'TransferBlood', to: { pool: 'A' }, amount: 1 },
    });
    expect(parse('draw crypt 2')).toEqual({
      ok: true,
      command: { type: 'Draw', seat: 'A', from: 'crypt', count: 2 },
    });
    expect(parse('direction predator')).toEqual({
      ok: true,
      command: { type: 'SetTurnDirection', direction: 'toPredator' },
    });
  });

  it('explains mistakes', () => {
    expect(parse('dance')).toEqual({ ok: false, error: 'Unknown command "dance"' });
    expect(parse('blood two ilse')).toEqual({ ok: false, error: 'Not a whole number: two' });
    expect(parse('lock')).toEqual({ ok: false, error: 'Usage: lock <card>' });
  });
});

describe('completeConsole', () => {
  it('completes commands, card names, zones and seats', () => {
    expect(completeConsole('lo', asA)).toEqual(['lock', 'look']);
    expect(completeConsole('lock i', asA)).toEqual(['"Ilse Várga"', '"Iron Ward"']);
    expect(completeConsole('move hand:1 to', asA)).toEqual(['torpor']);
    expect(completeConsole('edge ', asA)).toContain('none');
  });

  it('never suggests names the actor cannot see', () => {
    expect(completeConsole('lock "Iron', asB)).toEqual([]);
  });
});
