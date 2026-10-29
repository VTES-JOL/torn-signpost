import { describe, expect, it } from 'vitest';
import type { Command } from './commands.ts';
import { type DecideResult, decide } from './decide.ts';
import { evolve, newGame } from './evolve.ts';
import type { Actor, GameState } from './model.ts';
import { seededRng } from './rng.ts';
import { testCatalog as catalog } from './testing/fixtures.ts';

const rng = seededRng(9);
const seats = (n: number) =>
  ['A', 'B', 'C', 'D', 'E', 'F'].slice(0, n).map((id) => ({
    id,
    user: id.toLowerCase(),
    crypt: ['t-vera', 't-tomas'],
    library: ['t-feed', 't-ward', 't-signal'],
  }));
const start = (cmd: Partial<Extract<Command, { type: 'StartGame' }>> = {}): DecideResult =>
  decide(
    newGame('g'),
    { type: 'StartGame', gameId: 'g', format: 'standard', seats: seats(3), ...cmd },
    { actor: { kind: 'system' }, now: 't', rng, catalog },
  );
const started = (): GameState => {
  const r = start();
  if (!r.ok) throw new Error(r.rejection.message);
  return r.events.reduce(evolve, newGame('g'));
};
const run = (state: GameState, cmd: Command, actor: Actor = { kind: 'player', user: 'a' }) =>
  decide(state, cmd, { actor, now: 't', rng, catalog });
const apply = (state: GameState, cmd: Command, actor?: Actor) => {
  const r = run(state, cmd, actor);
  if (!r.ok) throw new Error(r.rejection.message);
  return r.events.reduce(evolve, state);
};

describe('StartGame', () => {
  it('enforces table sizes: 3–5 players, duels exactly 2 (GAME-01)', () => {
    expect(start({ seats: seats(2) })).toMatchObject({ ok: false });
    expect(start({ seats: seats(6) })).toMatchObject({ ok: false });
    expect(start({ format: 'duel', seats: seats(2) })).toMatchObject({ ok: true });
    expect(start({ format: 'duel', seats: seats(3) })).toMatchObject({ ok: false });
  });

  it('rejects unknown cards and cards in the wrong deck', () => {
    expect(
      start({ seats: [...seats(2), { id: 'C', user: 'c', crypt: ['nope'], library: [] }] }),
    ).toMatchObject({
      ok: false,
      rejection: { code: 'unknown-card' },
    });
    expect(
      start({ seats: [...seats(2), { id: 'C', user: 'c', crypt: ['t-feed'], library: [] }] }),
    ).toMatchObject({
      ok: false,
      rejection: { code: 'invalid' },
    });
  });

  it('only the system can start a game, once', () => {
    const state = started();
    expect(
      run(newGame('g'), { type: 'StartGame', gameId: 'g', format: 'standard', seats: seats(3) }),
    ).toMatchObject({
      rejection: { code: 'forbidden' },
    });
    expect(
      decide(
        state,
        { type: 'StartGame', gameId: 'g', format: 'standard', seats: seats(3) },
        {
          actor: { kind: 'system' },
          now: 't',
          rng,
          catalog,
        },
      ),
    ).toMatchObject({ rejection: { code: 'wrong-status' } });
  });
});

describe('re-keying (§4.5)', () => {
  it('gives a card a fresh instance ID whenever it enters a hidden zone', () => {
    let state = apply(started(), { type: 'Draw', seat: 'A', count: 1 });
    const inHand = state.zones['A:hand']?.[0] ?? '';
    state = apply(state, { type: 'MoveCard', card: inHand, to: 'A:ready' });
    expect(state.zones['A:ready']).toEqual([inHand]);
    state = apply(state, { type: 'MoveCard', card: inHand, to: 'A:library', position: 'bottom' });
    const bottom = state.zones['A:library']?.at(-1);
    expect(bottom).not.toBe(inHand);
    expect(state.cards[inHand]).toBeUndefined();
  });

  it('strips state from cards entering hidden zones', () => {
    let state = apply(started(), { type: 'Draw', seat: 'A', from: 'crypt' });
    const vamp = state.zones['A:uncontrolled']?.[0] ?? '';
    state = apply(state, {
      type: 'TransferBlood',
      from: { pool: 'A' },
      to: { card: vamp },
      amount: 2,
    });
    state = apply(state, { type: 'MoveCard', card: vamp, to: 'A:ready' });
    state = apply(state, { type: 'SetLocked', card: vamp, locked: true });
    state = apply(state, { type: 'MoveCard', card: vamp, to: 'A:crypt', position: 'bottom' });
    const id = state.zones['A:crypt']?.at(-1) ?? '';
    expect(state.cards[id]).toMatchObject({ locked: false, counters: {}, controller: 'A' });
  });
});

describe('permissions (GAME-10)', () => {
  it('rejects players who are not seated, and ousted players', () => {
    const state = started();
    expect(
      run(state, { type: 'AdjustPool', seat: 'A', delta: 1 }, { kind: 'player', user: 'zed' }),
    ).toMatchObject({
      rejection: { code: 'not-seated' },
    });
    const ousted: GameState = {
      ...state,
      seats: state.seats.map((s) => (s.id === 'A' ? { ...s, ousted: { atSeq: 1 } } : s)),
    };
    expect(run(ousted, { type: 'AdjustPool', seat: 'B', delta: 1 })).toMatchObject({
      rejection: { code: 'not-seated' },
    });
  });

  it("keeps players out of each other's hands", () => {
    const state = apply(
      started(),
      { type: 'Draw', seat: 'B', count: 1 },
      { kind: 'player', user: 'b' },
    );
    const card = state.zones['B:hand']?.[0] ?? '';
    expect(run(state, { type: 'MoveCard', card, to: 'B:ashHeap' })).toMatchObject({
      rejection: { code: 'hidden' },
    });
    expect(run(state, { type: 'Draw', seat: 'B' })).toMatchObject({
      rejection: { code: 'forbidden' },
    });
    expect(
      run(state, { type: 'MoveCard', card, to: 'B:ashHeap' }, { kind: 'judge', user: 'j' }),
    ).toMatchObject({
      ok: true,
      events: [{ by: { kind: 'judge', user: 'j' } }],
    });
  });

  it('only puts cards into their owner’s hidden zones', () => {
    let state = apply(started(), { type: 'Draw', seat: 'A', count: 1 });
    const card = state.zones['A:hand']?.[0] ?? '';
    state = apply(state, { type: 'MoveCard', card, to: 'B:ready' });
    expect(state.cards[card]?.controller).toBe('B');
    expect(run(state, { type: 'MoveCard', card, to: 'B:hand' })).toMatchObject({
      rejection: { code: 'invalid' },
    });
    expect(run(state, { type: 'MoveCard', card, to: 'A:hand' })).toMatchObject({ ok: true });
  });
});

describe('ReplacePlayer (GAME-19)', () => {
  it('hands the seat to the new player; the old one can no longer act', () => {
    const state = apply(
      started(),
      { type: 'ReplacePlayer', seat: 'A', user: 'zed' },
      { kind: 'admin', user: 'adm' },
    );
    expect(state.seats[0]).toMatchObject({
      occupant: 'zed',
      occupants: [
        { user: 'a', reason: 'start', to: 2 },
        { user: 'zed', reason: 'replaced', from: 2 },
      ],
    });
    expect(run(state, { type: 'AdjustPool', seat: 'A', delta: 1 })).toMatchObject({
      rejection: { code: 'not-seated' },
    });
    expect(
      run(state, { type: 'AdjustPool', seat: 'A', delta: 1 }, { kind: 'player', user: 'zed' }),
    ).toMatchObject({ ok: true });
  });
});

describe('AdvancePhase', () => {
  it('skips ousted seats when passing the turn', () => {
    let state = started();
    state = {
      ...state,
      seats: state.seats.map((s) => (s.id === 'B' ? { ...s, ousted: { atSeq: 1 } } : s)),
    };
    for (let i = 0; i < 5; i++) state = apply(state, { type: 'AdvancePhase' });
    expect(state.turn).toEqual({ number: 2, seat: 'C', phase: 'unlock' });
  });
});
