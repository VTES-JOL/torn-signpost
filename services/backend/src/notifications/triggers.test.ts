import { expand } from '@torn-signpost/cards';
import {
  type Actor,
  type Command,
  decide,
  evolve,
  type GameEvent,
  type GameState,
  newGame,
  seededRng,
  waitingOn,
  zoneId,
} from '@torn-signpost/engine';
import { describe, expect, it } from 'vitest';
import { testContent, testDeck } from '../testing/content.ts';
import { gameNotifications, mentioned } from './triggers.ts';

const { catalog } = await testContent();
const rng = seededRng(7);
let clock = Date.parse('2026-11-05T10:00:00Z');
const tick = () => {
  clock += 1000;
  return new Date(clock).toISOString();
};

function apply(state: GameState, command: Command, actor: Actor) {
  const r = decide(state, command, {
    actor,
    now: tick(),
    rng,
    catalog,
  });
  if (!r.ok) throw new Error(r.rejection.message);
  return { events: r.events, after: r.events.reduce(evolve, state) };
}

function started(settings: { deadlineMs?: number } = {}) {
  const users = ['alice', 'bob', 'carol'];
  return apply(
    newGame('g'),
    {
      type: 'StartGame',
      gameId: 'g',
      format: 'standard',
      seats: users.map((user, i) => ({ id: String(i + 1), user, ...expand(testDeck) })),
      settings,
    },
    { kind: 'system' },
  ).after;
}

const HOUR = 60 * 60 * 1000;
const judgeJo = { kind: 'judge', user: 'jo' } as const;

const occupantOf = (s: GameState, seat: string | undefined) =>
  s.seats.find((x) => x.id === seat)?.occupant ?? '';

/** The command, by whoever it's from, and what it notifies. */
function notify(before: GameState, command: Command, by: string | undefined, judges?: string[]) {
  const actor: Actor = by ? { kind: 'player', user: by } : { kind: 'system' };
  const { events, after } = apply(before, command, actor);
  return {
    after,
    drafts: gameNotifications({ before, after, events, actor: by, ...(judges ? { judges } : {}) }),
  };
}

describe('game notifications', () => {
  it('tells every player but the starter that the game started', () => {
    const after = started();
    const events: GameEvent[] = [];
    const drafts = gameNotifications({ before: newGame('g'), after, events, actor: 'alice' });
    expect(drafts.filter((d) => d.kind === 'started').map((d) => d.user)).toEqual(['bob', 'carol']);
  });

  it('tells the next player it is their turn, and nobody about their own moves', () => {
    let s = started();
    const first = occupantOf(s, s.turn?.seat);
    // The first player advances through their turn; each step is their own doing.
    for (let i = 0; i < 20 && occupantOf(s, s.turn?.seat) === first; i++) {
      const wait = waitingOn(s)[0];
      const by = occupantOf(s, wait?.seat);
      const step = notify(s, { type: wait?.kind === 'phase' ? 'AdvancePhase' : 'Pass' }, by);
      expect(step.drafts.some((d) => d.user === by)).toBe(false);
      if (occupantOf(step.after, step.after.turn?.seat) !== first) {
        const next = occupantOf(step.after, step.after.turn?.seat);
        expect(step.drafts).toContainEqual(expect.objectContaining({ user: next, kind: 'turn' }));
        // The turn notification covers the first phase: no separate decision for it.
        expect(step.drafts.filter((d) => d.user === next)).toHaveLength(1);
      }
      s = step.after;
    }
    expect(occupantOf(s, s.turn?.seat)).not.toBe(first);
  });

  it('leaves out players at the table for turns and decisions', () => {
    let s = started();
    for (const seat of s.seats) {
      s = apply(s, { type: 'SetPresence', seat: seat.id, present: true }, { kind: 'system' }).after;
    }
    const first = occupantOf(s, s.turn?.seat);
    for (let i = 0; i < 20 && occupantOf(s, s.turn?.seat) === first; i++) {
      const wait = waitingOn(s)[0];
      const step = notify(
        s,
        { type: wait?.kind === 'phase' ? 'AdvancePhase' : 'Pass' },
        occupantOf(s, wait?.seat),
      );
      expect(step.drafts.filter((d) => d.kind === 'turn' || d.kind === 'decision')).toEqual([]);
      s = step.after;
    }
  });

  it('tells judges about a call, and the caller about the ruling', () => {
    const s = started();
    const call = notify(s, { type: 'CallJudge', reason: 'rules' }, 'bob', ['jo', 'kim']);
    expect(call.drafts.filter((d) => d.kind === 'judge-call').map((d) => d.user)).toEqual([
      'jo',
      'kim',
    ]);
    const id = call.after.judgeCalls?.[0]?.id ?? '';
    const ruled = apply(
      call.after,
      { type: 'ResolveJudgeCall', id, ruling: { kind: 'answered' } },
      { kind: 'judge', user: 'jo' },
    );
    const drafts = gameNotifications({ before: call.after, ...ruled, actor: 'jo' });
    expect(drafts).toEqual([{ user: 'bob', kind: 'ruling', text: 'A judge ruled on your call' }]);
  });
});

describe('the end of a game', () => {
  it('tells every player it is over, and the winner that they won', () => {
    let s = started();
    s = apply(s, { type: 'AdjustVp', seat: '2', delta: 2 }, { kind: 'judge', user: 'jo' }).after;
    const end = apply(s, { type: 'EndGame' }, { kind: 'admin', user: 'ada' });
    const drafts = gameNotifications({ before: s, ...end, actor: 'ada' });
    const ended = drafts.filter((d) => d.kind === 'ended');
    expect(ended).toHaveLength(3);
    expect(ended.find((d) => d.user === 'bob')?.text).toBe(
      'The game is over: you won (a game win)',
    );
    expect(ended.find((d) => d.user === 'alice')?.text).toBe('The game is over');
  });
});

describe('withdrawal', () => {
  it('tells the player when it no longer holds, and when it takes them out', () => {
    const s = started();
    const by = { kind: 'judge', user: 'jo' } as const;
    const at = '2026-11-05T10:00:00.000Z';
    const drafts = gameNotifications({
      before: s,
      after: s,
      actor: 'jo',
      events: [
        { type: 'WithdrawalBroken', seat: '1', reason: 'pool', seq: 90, at, by },
        { type: 'Withdrew', seat: '2', vp: 0.5, seq: 91, at, by },
      ],
    });
    expect(drafts.filter((d) => d.kind === 'withdrawal')).toEqual([
      {
        user: 'alice',
        kind: 'withdrawal',
        text: 'Your withdrawal no longer holds: you lost or spent pool',
      },
      { user: 'bob', kind: 'withdrawal', text: 'You withdrew from the game (+½ VP)' },
    ]);
  });
});

describe('deadlines, ousts and blocks (M5b.5 leftovers)', () => {
  it('reminds an away player once half their time to decide has gone', () => {
    const s = started({ deadlineMs: 24 * HOUR });
    // Not yet: nothing is due.
    clock += 11 * HOUR;
    expect(() => apply(s, { type: 'CheckDeadline', seat: '1' }, { kind: 'system' })).toThrow();
    clock += 2 * HOUR;
    const { drafts } = notify(s, { type: 'CheckDeadline', seat: '1' }, undefined);
    expect(drafts).toEqual([
      { user: 'alice', kind: 'deadline', text: 'Half your time to decide has gone' },
    ]);
  });

  it('tells a player they were ousted, or disqualified', () => {
    const s = started();
    const pool = s.seats.find((x) => x.id === '2')?.pool ?? 0;
    const oust = apply(s, { type: 'AdjustPool', seat: '2', delta: -pool }, judgeJo);
    expect(gameNotifications({ before: s, ...oust, actor: 'jo' })).toContainEqual({
      user: 'bob',
      kind: 'ousted',
      text: 'You were ousted',
    });
    const call = apply(
      s,
      { type: 'CallJudge', reason: 'other', seat: '3' },
      {
        kind: 'player',
        user: 'alice',
      },
    ).after;
    const id = call.judgeCalls?.[0]?.id ?? '';
    const tournament = { ...call, settings: { ...call.settings, tournament: true } };
    const dq = apply(
      tournament,
      { type: 'ResolveJudgeCall', id, ruling: { kind: 'disqualify', seat: '3' } },
      judgeJo,
    );
    expect(gameNotifications({ before: tournament, ...dq, actor: 'jo' })).toContainEqual({
      user: 'carol',
      kind: 'ousted',
      text: 'A judge disqualified you',
    });
  });

  it('asks an away prey to decide on a block, and not one at the table', () => {
    let s = started();
    const alice = { kind: 'player', user: 'alice' } as const;
    const minion = s.zones[zoneId('1', 'uncontrolled')]?.[0] ?? '';
    s = apply(s, { type: 'MoveCard', card: minion, to: zoneId('1', 'ready') }, alice).after;
    while (s.turn?.phase !== 'minion') s = apply(s, { type: 'AdvancePhase' }, alice).after;
    const bleed = { type: 'DeclareAction', minion, kind: 'bleed', target: '2' } as const;
    expect(notify(s, bleed, 'alice').drafts).toContainEqual({
      user: 'bob',
      kind: 'decision',
      text: 'An action is coming your way: block it or let it through',
    });
    const present = apply(s, { type: 'SetPresence', seat: '2', present: true }, { kind: 'system' });
    expect(notify(present.after, bleed, 'alice').drafts.filter((d) => d.user === 'bob')).toEqual(
      [],
    );
  });
});

describe('mentions', () => {
  const people = [
    { user: 'u1', name: 'Alice' },
    { user: 'u2', name: 'Bob Smith' },
    { user: 'u3', name: 'Bo' },
  ];

  it('finds whole names after @, ignoring case, but never the author', () => {
    expect(mentioned('thanks @alice!', people, 'u2')).toEqual(['u1']);
    expect(mentioned('@Bob Smith, your turn', people, 'u1')).toEqual(['u2']);
    expect(mentioned('@bo and @alice', people, 'u1')).toEqual(['u3']);
    expect(mentioned('@bob smithers', people, 'u1')).toEqual([]);
    expect(mentioned('alice, no at sign', people, 'u2')).toEqual([]);
  });
});
