import { describe, expect, it } from 'vitest';
import type { Command } from './commands.ts';
import { type DecideResult, decide } from './decide.ts';
import { evolve, newGame } from './evolve.ts';
import { waitingOn } from './flow.ts';
import type { Actor, GameState } from './model.ts';
import { availableActions } from './offers.ts';
import { seededRng } from './rng.ts';
import { testCatalog as catalog } from './testing/fixtures.ts';
import { withdrawalBreaks } from './withdrawal.ts';

const rng = seededRng(9);
const seats = (n: number) =>
  ['A', 'B', 'C', 'D', 'E', 'F'].slice(0, n).map((id) => ({
    id,
    user: id.toLowerCase(),
    crypt: Array.from({ length: 6 }, (_, i) => (i % 2 ? 't-tomas' : 't-vera')),
    library: Array.from({ length: 12 }, (_, i) => ['t-feed', 't-ward', 't-signal'][i % 3] ?? ''),
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

  it('deals the opening draw: 4 crypt cards and 7 library cards, seen only by the owner', () => {
    const state = started();
    expect(state.zones['A:uncontrolled']).toHaveLength(4);
    expect(state.zones['A:crypt']).toHaveLength(2);
    expect(state.zones['A:hand']).toHaveLength(7);
    expect(state.zones['A:library']).toHaveLength(5);
    const r = start();
    // One event: the deal isn't logged as draws.
    expect(r.ok && r.events.map((e) => e.type)).toEqual(['GameStarted']);
  });

  it('deals what there is from a short deck', () => {
    const r = start({
      seats: seats(3).map((s) => ({ ...s, crypt: ['t-vera'], library: ['t-feed'] })),
    });
    if (!r.ok) throw new Error(r.rejection.message);
    const state = r.events.reduce(evolve, newGame('g'));
    expect(state.zones['A:uncontrolled']).toHaveLength(1);
    expect(state.zones['A:hand']).toHaveLength(1);
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

describe('SetPresence (TEMPO-06)', () => {
  const system: Actor = { kind: 'system' };
  it('records arrival and absence, attributed to the system', () => {
    const r = run(started(), { type: 'SetPresence', seat: 'B', present: true }, system);
    expect(r).toMatchObject({
      ok: true,
      events: [{ type: 'PlayerPresent', seat: 'B', by: system }],
    });
    const state = apply(started(), { type: 'SetPresence', seat: 'B', present: true }, system);
    expect(state.seats[1]?.present).toBe(true);
    const away = apply(state, { type: 'SetPresence', seat: 'B', present: false }, system);
    expect(away.seats[1]).not.toHaveProperty('present');
  });
  it('refuses no-ops, players, judges and ousted seats', () => {
    const cmd: Command = { type: 'SetPresence', seat: 'A', present: false };
    expect(run(started(), cmd, system)).toMatchObject({ rejection: { code: 'no-change' } });
    expect(run(started(), { ...cmd, present: true })).toMatchObject({
      rejection: { code: 'forbidden' },
    });
    expect(run(started(), { ...cmd, present: true }, { kind: 'judge', user: 'j' })).toMatchObject({
      rejection: { code: 'forbidden' },
    });
    const ousted = apply(started(), { type: 'AdjustPool', seat: 'A', delta: -30 });
    expect(run(ousted, { ...cmd, present: true }, system)).toMatchObject({
      rejection: { code: 'invalid' },
    });
  });
});

describe('waitingOn (UX-09)', () => {
  it('waits on the acting Methuselah, counting from when the wait began', () => {
    const state = started();
    const turnSeat = state.turn?.seat ?? '';
    const user = state.seats.find((s) => s.id === turnSeat)?.occupant ?? '';
    const actor: Actor = { kind: 'player', user };
    expect(waitingOn(state)).toEqual([
      { seat: turnSeat, kind: 'phase', since: { seq: state.seq, at: 't' } },
    ]);
    // Doing things within the wait doesn't restart it…
    const busy = apply(state, { type: 'AdjustPool', seat: turnSeat, delta: -1 }, actor);
    expect(waitingOn(busy)[0]?.since.seq).toBe(state.seq);
    // …a new phase does.
    const next = apply(busy, { type: 'AdvancePhase' }, actor);
    expect(next.turn?.phase).toBe('master');
    expect(waitingOn(next)[0]?.since.seq).toBe(next.seq);
  });
});

describe('judge calls (GAME-18)', () => {
  const judge: Actor = { kind: 'judge', user: 'jo' };
  const called = () => apply(started(), { type: 'CallJudge', reason: 'other' });
  it('lets judges, and only judges, answer; casual games escalate instead of disqualifying', () => {
    const state = called();
    const id = state.judgeCalls?.[0]?.id ?? '';
    expect(state.judgeCalls?.[0]).toMatchObject({ id: `c${state.seq}`, reason: 'other', by: 'A' });
    expect(run(state, { type: 'ClaimJudgeCall', id })).toMatchObject({
      rejection: { code: 'forbidden' },
    });
    const dq: Command = {
      type: 'ResolveJudgeCall',
      id,
      ruling: { kind: 'disqualify', seat: 'B' },
    };
    expect(run(state, dq, judge)).toMatchObject({ rejection: { code: 'invalid' } });
    const passFor: Command = { ...dq, ruling: { kind: 'pass-for', seat: 'B' } };
    expect(run(state, passFor, judge)).toMatchObject({ rejection: { code: 'not-now' } });
    const escalated = apply(state, { ...dq, ruling: { kind: 'escalate' } }, judge);
    expect(escalated.judgeCalls).toBeUndefined();
  });
  it('refuses calls from judges and spectators, and unknown calls', () => {
    expect(run(started(), { type: 'CallJudge', reason: 'rules' }, judge)).toMatchObject({
      rejection: { code: 'not-seated' },
    });
    expect(run(called(), { type: 'ClaimJudgeCall', id: 'c999' }, judge)).toMatchObject({
      rejection: { code: 'invalid' },
    });
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

describe('game end (GAME-08/09, docs/m6-plan.md M6.1)', () => {
  const judge: Actor = { kind: 'judge', user: 'jo' };
  const admin: Actor = { kind: 'admin', user: 'ada' };
  const as = (user: string): Actor => ({ kind: 'player', user });

  it('an admin ends the game, scored as a timeout; players and judges cannot', () => {
    const s = apply(started(), { type: 'AdjustVp', seat: 'B', delta: 2 }, judge);
    for (const who of [as('a'), judge]) {
      expect(run(s, { type: 'EndGame' }, who)).toMatchObject({
        ok: false,
        rejection: { code: 'forbidden' },
      });
    }
    const done = apply(s, { type: 'EndGame', note: 'Out of time at the venue' }, admin);
    expect(done.status).toBe('finished');
    expect(done.result).toMatchObject({ reason: 'admin', winner: 'B', gameWin: 'B' });
    expect(done.seats.map((x) => x.vp)).toEqual([0.5, 2.5, 0.5]);
    // Nothing more happens in a finished game.
    expect(run(done, { type: 'AdvancePhase' }, as('a'))).toMatchObject({ ok: false });
  });

  it('a casual game ends when everyone still in it agrees; anyone can say no', () => {
    let s = apply(started(), { type: 'ProposeEnd' }, as('a'));
    s = apply(s, { type: 'AgreeEnd' }, as('b'));
    expect(s.status).toBe('active');
    const declined = apply(s, { type: 'DeclineEnd' }, as('c'));
    expect(declined.endProposal).toBeUndefined();
    s = apply(s, { type: 'AgreeEnd' }, as('c'));
    expect(s.status).toBe('finished');
    // Everyone at ½ VP: a tie, so nobody wins.
    expect(s.result).toEqual({ reason: 'agreement', at: 't' });
  });

  it('tournament games cannot end by agreement', () => {
    const r = start({ settings: { tournament: true } });
    if (!r.ok) throw new Error(r.rejection.message);
    const s = r.events.reduce(evolve, newGame('g'));
    expect(run(s, { type: 'ProposeEnd' }, as('a'))).toMatchObject({
      ok: false,
      rejection: { code: 'forbidden' },
    });
  });

  it('an ousted winner still wins; a game win needs 2 VP', () => {
    let s = apply(started(), { type: 'AdjustVp', seat: 'A', delta: 1 }, judge);
    s = apply(s, { type: 'EndGame' }, admin);
    // A: 1.5, B and C 0.5: A wins, but with under 2 VP it isn't a game win.
    expect(s.result).toMatchObject({ winner: 'A' });
    expect(s.result?.gameWin).toBeUndefined();
  });

  it('never passes the turn to a seat that is out: the last oust ends the game', () => {
    // The beta's "every seat ousted, turn passed to an ousted seat" game: here the player whose
    // turn it is goes out last, leaving one Methuselah.
    let s = started();
    const first = s.turn?.seat ?? 'A';
    const [other, last] = s.seats.map((x) => x.id).filter((x) => x !== first);
    s = apply(s, { type: 'AdjustPool', seat: other ?? '', delta: -30 }, judge);
    expect(s.status).toBe('active');
    const pool = s.seats.find((x) => x.id === first)?.pool ?? 0;
    s = apply(s, { type: 'AdjustPool', seat: first, delta: -pool }, judge);
    expect(s.status).toBe('finished');
    expect(s.result?.reason).toBe('last-standing');
    expect(s.seats.find((x) => x.id === last)?.ousted).toBeUndefined();
    // The turn didn't move on to anyone: the game was over.
    expect(s.turn?.seat).toBe(first);
  });
});

describe('withdrawal (GAME-09, docs/m6-plan.md M6.2)', () => {
  const judge: Actor = { kind: 'judge', user: 'jo' };
  const as = (seat: string): Actor => ({ kind: 'player', user: seat.toLowerCase() });

  /**
   * The seat whose turn it is, with an empty library, 6 cards in hand and a vampire ready with 3
   * blood, still in their unlock phase.
   */
  function ready() {
    let s = started();
    const t = s.turn?.seat ?? 'A';
    const library = s.zones[`${t}:library`] ?? [];
    s = apply(s, { type: 'Draw', seat: t, count: library.length }, as(t));
    for (const card of (s.zones[`${t}:hand`] ?? []).slice(6)) {
      s = apply(s, { type: 'MoveCard', card, to: `${t}:ashHeap` }, as(t));
    }
    const vampire = s.zones[`${t}:uncontrolled`]?.[0] ?? '';
    s = apply(s, { type: 'MoveCard', card: vampire, to: `${t}:ready` }, as(t));
    s = apply(s, { type: 'AdjustCounter', card: vampire, counter: 'blood', delta: 3 }, judge);
    return { s, t, vampire };
  }

  it('is offered exactly when it would be accepted', () => {
    const { s, t } = ready();
    const offered = (st: GameState, seat: string) =>
      availableActions(st, seat, catalog).some((o) => o.id === 'withdraw');
    expect(offered(s, t)).toBe(true);
    expect(run(s, { type: 'Withdraw' }, as(t)).ok).toBe(true);
    // A full hand: neither.
    const card = s.zones[`${t}:ashHeap`]?.[0] ?? '';
    const full = apply(s, { type: 'MoveCard', card, to: `${t}:hand` }, as(t));
    expect(offered(full, t)).toBe(false);
    expect(run(full, { type: 'Withdraw' }, as(t)).ok).toBe(false);
    // Pending already: neither.
    const pending = apply(s, { type: 'Withdraw' }, as(t));
    expect(offered(pending, t)).toBe(false);
    // Another player, or another phase: neither.
    const other = s.seats.find((x) => x.id !== t)?.id ?? '';
    expect(offered(s, other)).toBe(false);
    const master = apply(s, { type: 'AdvancePhase' }, as(t));
    expect(offered(master, t)).toBe(false);
    expect(run(master, { type: 'Withdraw' }, as(t)).ok).toBe(false);
  });

  it('is nullified by a vampire losing or spending blood, not by blood leaving play with it', () => {
    const { s, t, vampire } = ready();
    const w = apply(s, { type: 'Withdraw' }, as(t));
    const lost = apply(
      w,
      { type: 'AdjustCounter', card: vampire, counter: 'blood', delta: -1 },
      as(t),
    );
    expect(lost.seats.find((x) => x.id === t)?.withdrawing).toBeUndefined();
    const moved = apply(
      w,
      { type: 'TransferBlood', from: { card: vampire }, to: { pool: t }, amount: 1 },
      as(t),
    );
    expect(moved.seats.find((x) => x.id === t)?.withdrawing).toBeUndefined();
    // Burned with its blood on it: no loss (zero-vtes rules-qa 95.1).
    const burned = apply(w, { type: 'MoveCard', card: vampire, to: `${t}:ashHeap` }, as(t));
    expect(burned.seats.find((x) => x.id === t)?.withdrawing).toBeDefined();
    // A gain is no loss; an ally's life isn't blood (95.2).
    const gained = apply(
      w,
      { type: 'AdjustCounter', card: vampire, counter: 'blood', delta: 1 },
      as(t),
    );
    expect(gained.seats.find((x) => x.id === t)?.withdrawing).toBeDefined();
    const withLife = apply(
      w,
      { type: 'AdjustCounter', card: vampire, counter: 'life', delta: 2 },
      judge,
    );
    const life = apply(
      withLife,
      { type: 'AdjustCounter', card: vampire, counter: 'life', delta: -1 },
      judge,
    );
    expect(life.seats.find((x) => x.id === t)?.withdrawing).toBeDefined();
  });

  it('is nullified by another player taking their pool, as by their own doing', () => {
    const { s, t } = ready();
    const w = apply(s, { type: 'Withdraw' }, as(t));
    const after = apply(w, { type: 'AdjustPool', seat: t, delta: -2 }, judge);
    expect(after.seats.find((x) => x.id === t)?.withdrawing).toBeUndefined();
  });

  it('is nullified by a minion of theirs entering combat', () => {
    const { s, t, vampire } = ready();
    const w = apply(s, { type: 'Withdraw' }, as(t));
    // Straight to combat: a combat starting with one of theirs in it.
    const broke = withdrawalBreaks(
      { ...w, action: { seat: t, minion: vampire, kind: 'bleed', stage: 'blocks' } } as GameState,
      {
        type: 'CombatStarted',
        combat: {
          cause: 'block',
          acting: vampire,
          opposing: vampire,
          round: 1,
          step: 'before-range',
          range: 'close',
          strikes: [],
        },
      },
    );
    expect(broke).toEqual([[t, 'combat']]);
  });
});

describe('combat steps (docs/m6-plan.md M6.4a)', () => {
  const as = (seat: string): Actor => ({ kind: 'player', user: seat.toLowerCase() });
  /** A's vampire against B's, already in combat the way games before combat steps recorded it. */
  function oldCombat(): GameState {
    let s = started();
    const minion = (seat: string) => {
      const id = s.zones[`${seat}:uncontrolled`]?.[0] ?? '';
      s = apply(s, { type: 'MoveCard', card: id, to: `${seat}:ready` }, as(seat));
      return id;
    };
    const a = minion('A');
    const b = minion('B');
    return {
      ...s,
      turn: { number: 1, seat: 'A', phase: 'minion' },
      action: {
        seat: 'A',
        minion: a,
        kind: 'bleed',
        target: 'B',
        eligible: ['B'],
        declined: [],
        stage: 'combat',
        blocker: b,
      },
    };
  }

  it('leaves a combat from before them to be ended by hand, as before', () => {
    const s = oldCombat();
    expect(waitingOn(s).map((w) => `${w.seat}:${w.kind}`)).toEqual(['A:combat', 'B:combat']);
    expect(availableActions(s, 'B', catalog).map((o) => o.id)).toContain('endcombat');
    expect(run(s, { type: 'Pass' }, as('A')).ok).toBe(false);
    const ended = apply(s, { type: 'EndCombat' }, as('B'));
    expect(ended.action).toBeUndefined();
  });

  it('accepts a combat move only from the combatant holding the impulse, in its step', () => {
    let s = oldCombat();
    const { action } = s;
    if (!action) throw new Error('no action');
    const [acting, opposing] = [action.minion, action.blocker ?? ''];
    s = {
      ...s,
      action: {
        ...action,
        combat: {
          cause: 'block',
          acting,
          opposing,
          round: 1,
          step: 'strikes',
          range: 'close',
          strikes: [],
        },
      },
      window: { kind: 'combat', phase: 'minion', order: ['A', 'B'], cursor: 0, passes: 0 },
    };
    expect(run(s, { type: 'Strike', kind: 'hand' }, as('B'))).toMatchObject({
      ok: false,
      rejection: { code: 'not-now' },
    });
    expect(run(s, { type: 'Strike', kind: 'hand', amount: -1 }, as('A'))).toMatchObject({
      ok: false,
      rejection: { code: 'invalid' },
    });
    expect(run(s, { type: 'Maneuver', to: 'long' }, as('A'))).toMatchObject({
      ok: false,
      rejection: { code: 'not-now' },
    });
    const struck = apply(s, { type: 'Strike', kind: 'damage', amount: 3, ranged: true }, as('A'));
    expect(struck.action?.combat?.strikes).toEqual([
      { minion: acting, strike: { kind: 'damage', amount: 3, ranged: true } },
    ]);
    expect(struck.window?.cursor).toBe(1);
    // Not the source of a strike: someone else's card.
    expect(run(s, { type: 'Strike', kind: 'damage', source: opposing }, as('A'))).toMatchObject({
      ok: false,
      rejection: { code: 'invalid' },
    });
  });
});
