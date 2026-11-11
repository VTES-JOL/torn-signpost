import { describe, expect, it } from 'vitest';
import { titleBallots, titleVotes } from './catalog.ts';
import type { Command } from './commands.ts';
import { parseConsole } from './console/index.ts';
import { decide } from './decide.ts';
import { describeEvent } from './describe.ts';
import { evolve } from './evolve.ts';
import type { GameState } from './model.ts';
import type { OfferStep, StepValue } from './offers.ts';
import { availableActions } from './offers.ts';
import { project } from './projection.ts';
import { tally } from './referendum.ts';
import { seededRng } from './rng.ts';
import { runScenario } from './scenario.ts';
import { testCatalog } from './testing/fixtures.ts';

/** Three seats, each with a vampire in play; Sarah's political action is in its polling step. */
const POLLING = `seed 5
seat S sarah
seat X alexis
seat P pieter
crypt S "Marek Hale" *12
library S "Open Motion" *40
crypt X "Odile Fen" *12
library X "Open Motion" *20 "Signal Fire" *20
crypt P "Vera Nightfall" *12
library P "Iron Ward" *40
start
S> move S:uncontrolled:1 ready
X> move X:uncontrolled:1 ready
P> move P:uncontrolled:1 ready
S> next
S> next
S> political S:ready:1 with S:hand:1
X> pass
P> pass
S> resolve success
S> pass
expect window polling minion
`;

const run = (more: string) => {
  const r = runScenario(POLLING + more, testCatalog);
  expect(r.failure).toBeUndefined();
  return r;
};

describe('referendums (M6.5)', () => {
  it('counts title votes as the rulebook gives them', () => {
    expect(titleVotes('Primogen')).toBe(1);
    expect(titleVotes('Prince')).toBe(2);
    expect(titleVotes('Baron')).toBe(2);
    expect(titleVotes('Justicar')).toBe(3);
    expect(titleVotes('Inner Circle')).toBe(4);
    expect(titleVotes('Bishop')).toBe(1);
    expect(titleVotes('Archbishop')).toBe(2);
    expect(titleVotes('Cardinal')).toBe(3);
    expect(titleVotes('Regent')).toBe(4);
    expect(titleVotes('Magaji')).toBe(2);
    expect(titleVotes('2 votes')).toBe(2);
    expect(titleVotes('1 vote')).toBe(1);
    // The prisci share a block by ballots, not votes of their own.
    expect(titleVotes('Priscus')).toBe(0);
    expect(titleVotes(undefined)).toBe(0);
  });

  it('adds votes gained after casting to the cast, on the same side only (rules-qa 5.1)', () => {
    const r = run(`S> vote for S:ready:1
S> vote for S:ready:1 1 "Bewitching Oration"
log public Marek Hale adds 1 vote in favour: Bewitching Oration
expect votes 3 0
reject S> vote for S:ready:1
reject S> vote against S:ready:1 1
`);
    expect(r.state.action?.referendum?.votes).toEqual([
      expect.objectContaining({ minion: expect.any(String), votes: 3, claimed: true }),
    ]);
  });

  it('takes votes from untitled minions only as a claim, and other sources with a number', () => {
    // Vera Nightfall has no title: no votes unless a card gives her some.
    run(`S> pass
X> pass
reject P> vote for P:ready:1
P> vote for P:ready:1 1
log public Vera Nightfall casts 1 vote in favour (claimed)
`);
    run(`S> pass
X> vote against X:ready:1 2
log public Odile Fen casts 2 votes against (claimed)
reject X> vote against other
X> vote against other 1 "a borrowed vote"
log public X casts 1 vote against: a borrowed vote
expect votes 0 3
`);
    // A card from the hand is played for the votes; one in play is only named.
    const r = run(`S> pass
X> vote for other 2 via X:hand:1
expect count X:ashHeap 1
expect count X:hand 7
expect votes 2 0
`);
    expect(r.state.action?.referendum?.votes[0]).toMatchObject({ source: 'other', votes: 2 });
  });

  it('refuses votes out of turn, without the Edge, or from the wrong side of the table', () => {
    run(`reject X> vote for X:ready:1
reject S> vote for edge
reject S> vote for S:ready:1 31
S> pass
reject X> vote for card
reject X> vote for P:ready:1 1
reject X> hold
`);
  });

  it('lets anyone abstain before polling, and closes once everyone has passed or abstains', () => {
    const r = runScenario(
      POLLING.replace('S> pass\nexpect window polling minion\n', '') +
        `expect window referendum minion
X> abstain
P> abstain
reject P> abstain
S> pass
expect window polling minion
expect impulse S
S> vote for S:ready:1
S> pass
log public The referendum passes (2 for, 0 against)
expect action none
`,
      testCatalog,
    );
    expect(r.failure).toBeUndefined();
  });

  it('drops an ousted Methuselah from the polling', () => {
    run(`S> pass
X> vote against X:ready:1 1
X> pool -30
expect ousted X true
expect impulse P
P> pass
S> pass
log public The referendum fails (0 for, 1 against)
`);
  });

  it('offers each titled vampire, the calling card and passing to the voter', () => {
    const r = run('');
    const view = project(r.state, { kind: 'player', seat: 'S' });
    const labels = availableActions(view, 'S', testCatalog).map((o) => o.label);
    expect(labels).toContain('Vote with Marek Hale (2)…');
    expect(labels).toContain('The calling card’s vote…');
    expect(labels).not.toContain('Burn a political action card for a vote…');
    expect(labels).toEqual(expect.arrayContaining(['Other votes…', 'Pass', 'Abstain']));
    const theirs = availableActions(
      project(r.state, { kind: 'player', seat: 'X' }),
      'X',
      testCatalog,
    );
    expect(theirs.map((o) => o.id)).toEqual(['abstain']);
    const vote = availableActions(view, 'S', testCatalog).find((o) => o.id.startsWith('vote:'));
    expect(vote?.build(['against'])).toMatchObject({ type: 'CastVotes', side: 'against' });
  });

  it('asks for the terms when a political action succeeds', () => {
    const r = runScenario(POLLING.split('S> resolve success')[0] ?? '', testCatalog);
    const offers = availableActions(
      project(r.state, { kind: 'player', seat: 'S' }),
      'S',
      testCatalog,
    );
    const success = offers.find((o) => o.id === 'success');
    expect(success?.label).toBe('Successful: call the referendum');
    expect(success?.build(['  gain 3 pool '])).toEqual({
      type: 'ResolveAction',
      outcome: 'success',
      terms: 'gain 3 pool',
    });
  });

  it('parses the console’s vote commands', () => {
    const r = run('');
    const ctx = { view: r.state, seat: 'S', catalog: testCatalog };
    const parsed = (line: string) => {
      const p = parseConsole(line, ctx);
      return p.ok ? p.command : p.error;
    };
    expect(parsed('vote for S:ready:1')).toMatchObject({ source: 'minion', side: 'for' });
    expect(parsed('vote against edge')).toEqual({
      type: 'CastVotes',
      source: 'edge',
      side: 'against',
    });
    expect(parsed('vote for card')).toMatchObject({ source: 'card' });
    expect(parsed('vote for S:hand:1')).toMatchObject({ source: 'burned' });
    expect(parsed('vote for other 2 "a note"')).toMatchObject({
      source: 'other',
      votes: 2,
      note: 'a note',
    });
    expect(parsed('vote maybe edge')).toMatch(/^Usage/);
    expect(parsed('vote for other')).toMatch(/How many votes/);
    expect(parsed('abstain')).toEqual({ type: 'Abstain' });
    // The engine refuses it: the Edge is worth 1 vote.
    expect(parsed('vote for edge 2')).toMatchObject({ source: 'edge', votes: 2 });
    expect(parsed('vote for S:hand:1 2')).toMatch(/^Usage/);
    expect(parsed('vote for S:ready:1 via S:hand:1')).toMatch(/^Usage/);
    expect(parsed('vote')).toMatch(/^Usage/);
    expect(parsed('vote for other 1 via S:ready:1 a b')).toMatchObject({
      source: 'other',
      votes: 1,
      card: expect.any(String),
      note: 'a b',
    });
    expect(parsed('vote against S:ready:1 3 claimed')).toMatchObject({
      source: 'minion',
      votes: 3,
      note: 'claimed',
    });
    expect(parsed('resolve success "gain 3 pool"')).toEqual({
      type: 'ResolveAction',
      outcome: 'success',
      terms: 'gain 3 pool',
    });
    expect(parsed('resolve failure soon')).toMatch(/^Usage/);
  });

  it('builds commands the engine accepts from every polling offer', () => {
    const first = (step: OfferStep): StepValue => {
      switch (step.kind) {
        case 'card':
          return step.candidates[0];
        case 'seat':
          return step.candidates[0];
        case 'amount':
          return step.default;
        case 'toggle':
          return step.default;
        case 'choice':
          return step.default ?? step.options[0]?.value;
        case 'text':
          return 'a note';
      }
    };
    const accepted = (state: GameState, seat: string, user: string) => {
      const offers = availableActions(project(state, { kind: 'player', seat }), seat, testCatalog);
      for (const o of offers) {
        const cmd = o.build(o.steps.map(first));
        const r = decide(state, cmd, {
          actor: { kind: 'player', user },
          now: '2026-01-01T00:00:00.000Z',
          rng: seededRng(1),
          catalog: testCatalog,
        });
        expect(r.ok, `${o.label}: ${r.ok ? '' : r.rejection.message}`).toBe(true);
      }
      return offers.map((o) => o.id);
    };
    // The caller, with the Edge and a card in play to name.
    const caller = run('').state;
    const withEdge = runScenario(
      POLLING.replace('S> political', 'S> edge S\nS> political'),
      testCatalog,
    ).state;
    expect(accepted(withEdge, 'S', 'sarah')).toEqual(
      expect.arrayContaining(['vote:edge', 'vote:card', 'vote:other', 'pass', 'abstain']),
    );
    expect(accepted(caller, 'S', 'sarah')).toContain('play');
    // Another Methuselah, with political action cards in hand.
    const theirs = run('S> pass\n').state;
    expect(accepted(theirs, 'X', 'alexis')).toEqual(
      expect.arrayContaining(['vote:burn', 'vote:minion', 'use']),
    );
  });

  it('tells every kind of cast in the log', () => {
    const r = run(`S> vote for S:ready:1
S> vote for card
S> pass
X> vote against other 1 via X:ready:1 "a favour"
X> vote against "Open Motion"
X> pass
P> vote for other 1 via P:hand:1
P> abstain
S> pass
X> pass
`);
    let state = runScenario('seat S s\nseat X x\nseat P p\n', testCatalog).state;
    const lines: string[] = [];
    for (const ev of r.events) {
      const line = describeEvent(ev, state, { catalog: testCatalog });
      if (line) lines.push(line);
      state = evolve(state, ev);
    }
    expect(lines).toEqual(
      expect.arrayContaining([
        'Marek Hale calls a referendum',
        'Polling: votes may be cast',
        'Marek Hale casts 2 votes in favour',
        "S casts Open Motion's 1 vote in favour",
        'X casts 1 vote against with Odile Fen: a favour',
        'X burns Open Motion for 1 vote against',
        'P abstains from the rest of the referendum',
        'P plays Iron Ward for 1 vote in favour',
        'The referendum passes (4 for, 2 against)',
      ]),
    );
  });

  it('refuses votes the rules don’t allow, saying why', () => {
    const state = run('').state;
    const hand = state.zones['S:hand'] ?? [];
    const ready = state.zones['S:ready'] ?? [];
    const send = (cmd: Command, user = 'sarah', at = state) => {
      const r = decide(at, cmd, {
        actor: { kind: 'player', user },
        now: '2026-01-01T00:00:00.000Z',
        rng: seededRng(1),
        catalog: testCatalog,
      });
      return r.ok ? 'accepted' : r.rejection.message;
    };
    const cast = (more: Partial<Extract<Command, { type: 'CastVotes' }>>) =>
      send({ type: 'CastVotes', source: 'other', side: 'for', ...more } as Command);
    expect(cast({ side: 'maybe' as 'for', votes: 1 })).toMatch(/Vote for or against/);
    expect(cast({ votes: 0 })).toMatch(/Invalid number of votes/);
    expect(cast({ votes: 1, note: 'x'.repeat(201) })).toMatch(/too long/);
    expect(cast({})).toMatch(/How many votes/);
    expect(cast({ source: 'minion' })).toMatch(/Which minion/);
    expect(cast({ source: 'card', votes: 2 })).toMatch(/worth 1 vote/);
    expect(cast({ source: 'burned' })).toMatch(/Which political action card/);
    expect(cast({ source: 'burned', card: ready[0] ?? '' })).toMatch(/from your hand/);
    expect(cast({ source: 'burned', card: hand[0] ?? '' })).toMatch(/calling the referendum/);
    expect(cast({ source: 'nothing' as 'other' })).toMatch(/Unknown source/);
    expect(send({ type: 'CastVotes', source: 'edge', side: 'for' }, 'alexis')).toMatch(
      /not your impulse/,
    );
    // Before the referendum, there is nothing to vote in or abstain from.
    const before = runScenario(POLLING.split('S> political')[0] ?? '', testCatalog).state;
    expect(send({ type: 'Abstain' }, 'sarah', before)).toMatch(/no referendum/);
    expect(
      send(
        { type: 'ResolveAction', outcome: 'success', terms: 'x'.repeat(201) },
        'sarah',
        runScenario(POLLING.split('S> resolve success')[0] ?? '', testCatalog).state,
      ),
    ).toMatch(/terms are too long/);
    // Abstaining twice, or casting after abstaining.
    const abstained = run('S> abstain\n').state;
    expect(send({ type: 'Abstain' }, 'sarah', abstained)).toMatch(/already abstain/);
  });

  it('counts the prisci block for the side with more ballots, and nobody on a tie', () => {
    const r = (ballots: [number, number], votes: [number, number] = [0, 0]) =>
      tally({
        votes: [
          { seat: 'A', source: 'minion', side: 'for', votes: votes[0], ballots: ballots[0] },
          { seat: 'B', source: 'minion', side: 'against', votes: votes[1], ballots: ballots[1] },
        ],
      });
    expect(r([2, 1])).toEqual({ for: 3, against: 0, prisci: { for: 2, against: 1, side: 'for' } });
    expect(r([0, 1], [2, 0])).toMatchObject({ for: 2, against: 3 });
    expect(r([1, 1], [1, 1])).toEqual({ for: 1, against: 1, prisci: { for: 1, against: 1 } });
    expect(tally({ votes: [] })).toEqual({ for: 0, against: 0 });
    expect(titleBallots('Priscus')).toBe(1);
    expect(titleBallots('Prince')).toBe(0);
  });

  it('offers a blood hunt as a diablerie resolves, and refuses one at the wrong time', () => {
    const resolving = runScenario(
      POLLING.split('S> political')[0] +
        'S> action S:ready:1 X\nX> pass\nexpect action other S resolution\n',
      testCatalog,
    );
    expect(resolving.failure).toBeUndefined();
    const offers = availableActions(
      project(resolving.state, { kind: 'player', seat: 'S' }),
      'S',
      testCatalog,
    );
    const hunt = offers.find((o) => o.id === 'blood-hunt');
    expect(hunt?.build([undefined])).toEqual({ type: 'CallBloodHunt' });
    expect(hunt?.build(['m1'])).toEqual({ type: 'CallBloodHunt', minion: 'm1' });
    const send = (cmd: Command, at: GameState, user = 'sarah') => {
      const r = decide(at, cmd, {
        actor: { kind: 'player', user },
        now: '2026-01-01T00:00:00.000Z',
        rng: seededRng(1),
        catalog: testCatalog,
      });
      return r.ok ? 'accepted' : r.rejection.message;
    };
    const handCard = resolving.state.zones['S:hand']?.[0] ?? '';
    expect(send({ type: 'CallBloodHunt', minion: handCard }, resolving.state)).toMatch(/in play/);
    expect(send({ type: 'CallBloodHunt' }, resolving.state, 'alexis')).toMatch(/not your action/);
    expect(send({ type: 'EndReferendum', passed: true }, resolving.state)).toMatch(/no referendum/);
    const polling = run('').state;
    expect(send({ type: 'CallBloodHunt' }, polling)).toMatch(/as the action resolves/);
    expect(send({ type: 'EndReferendum', passed: false, note: 'x'.repeat(201) }, polling)).toMatch(
      /too long/,
    );
    const ready = polling.zones['S:ready']?.[0] ?? '';
    const cast = (more: object) =>
      send(
        { type: 'CastVotes', source: 'minion', side: 'for', minion: ready, ...more } as Command,
        polling,
      );
    expect(cast({ ballots: 0 })).toMatch(/Invalid number of ballots/);
    expect(cast({ source: 'other', votes: 1, ballots: 1 })).toMatch(/Only a minion casts ballots/);
    expect(cast({ ballots: 2 })).toBe('accepted');
    expect(send({ type: 'CancelVotes', minion: handCard }, polling)).toMatch(/minion in play/);
    const silenced = run('S> abstain S:ready:1\n').state;
    expect(send({ type: 'CancelVotes', minion: ready }, silenced)).toMatch(/already abstains/);
    const before = runScenario(POLLING.split('S> political')[0] ?? '', testCatalog).state;
    expect(send({ type: 'CancelVotes', minion: ready }, before)).toMatch(/impulse/);
  });

  it('parses the console’s blood hunt, abstain and end commands', () => {
    const r = run('');
    const ctx = { view: r.state, seat: 'S', catalog: testCatalog };
    const parsed = (line: string) => {
      const p = parseConsole(line, ctx);
      return p.ok ? p.command : p.error;
    };
    expect(parsed('bloodhunt')).toEqual({ type: 'CallBloodHunt' });
    expect(parsed('bloodhunt S:ready:1')).toMatchObject({ type: 'CallBloodHunt' });
    expect(parsed('abstain S:ready:1')).toMatchObject({ type: 'CancelVotes' });
    expect(parsed('abstain S:ready:1 via S:hand:2')).toMatchObject({
      type: 'CancelVotes',
      source: expect.any(String),
    });
    expect(parsed('abstain S:ready:1 X:ready:1')).toMatch(/^Usage/);
    expect(parsed('endreferendum pass Yoruba Shrine')).toEqual({
      type: 'EndReferendum',
      passed: true,
      note: 'Yoruba Shrine',
    });
    expect(parsed('endreferendum fail')).toEqual({ type: 'EndReferendum', passed: false });
    expect(parsed('endreferendum maybe')).toMatch(/^Usage/);
  });
});
