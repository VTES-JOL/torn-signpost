import type { ActionState, GameState, Wait } from '@torn-signpost/engine';
import { describe, expect, it } from 'vitest';
import { promptFor } from './FlowBar.tsx';

const who = (s: string) => ({ A: 'Alice', B: 'Bob', C: 'Carol' })[s] ?? s;
const name = (id: string | undefined) => (id === 'm1' ? 'Julia Prima' : 'Tomas Grey');
const since = { seq: 9 };
const wait = (seat: string, kind: Wait['kind']): Wait => ({ seat, kind, since });
const view = (extra: Partial<GameState> = {}) =>
  ({ turn: { number: 2, seat: 'A', phase: 'minion' }, ...extra }) as GameState;
const bleed: ActionState = {
  seat: 'A',
  minion: 'm1',
  kind: 'bleed',
  target: 'B',
  eligible: ['B'],
  declined: [],
  stage: 'blocks',
};

describe('decision prompts (UX-09)', () => {
  it('asks the deciding player, and tells everyone else who the table waits on', () => {
    const blocks = view({
      action: bleed,
      window: { kind: 'blocks', phase: 'minion', order: ['A', 'B'], cursor: 1, passes: 0 },
    });
    const waits = [wait('B', 'block')];
    expect(promptFor(blocks, 'B', waits, who, name)).toEqual({
      mine: true,
      text: "Block Julia Prima's bleed?",
    });
    expect(promptFor(blocks, 'C', waits, who, name)).toEqual({
      mine: false,
      text: 'Waiting on Bob (block decision)',
    });
    expect(promptFor(blocks, undefined, waits, who, name)?.mine).toBe(false);
  });

  it('covers phases, resolution and combat', () => {
    expect(promptFor(view(), 'A', [wait('A', 'phase')], who, name)?.text).toBe(
      'Your minion phase: act, then end the phase',
    );
    expect(promptFor(view(), 'B', [wait('A', 'phase')], who, name)?.text).toBe(
      'Waiting on Alice (minion phase)',
    );
    const resolving = view({ action: { ...bleed, stage: 'resolution' } });
    expect(promptFor(resolving, 'A', [wait('A', 'resolve')], who, name)?.text).toBe(
      "Resolve Julia Prima's bleed: did it succeed?",
    );
    const combat = [wait('A', 'combat'), wait('B', 'combat')];
    const fighting = view({ action: { ...bleed, stage: 'combat', blocker: 'm2' } });
    expect(promptFor(fighting, 'B', combat, who, name)?.mine).toBe(true);
    expect(promptFor(fighting, 'C', combat, who, name)?.text).toBe(
      'Waiting on Alice and Bob (combat)',
    );
  });

  it('names the combat step: a strike to choose, or a card to play or pass (M6.4)', () => {
    const cards = {
      m1: { id: 'm1', owner: 'A', controller: 'A', zone: 'A:ready' },
      m2: { id: 'm2', owner: 'B', controller: 'B', zone: 'B:ready' },
    } as unknown as GameState['cards'];
    const combat = (step: 'range' | 'strikes', strikes: { minion: string }[] = []) =>
      view({
        cards,
        action: {
          ...bleed,
          stage: 'combat',
          blocker: 'm2',
          combat: {
            cause: 'block',
            acting: 'm1',
            opposing: 'm2',
            round: 1,
            step,
            range: 'long',
            strikes: strikes.map((x) => ({ ...x, strike: { kind: 'hand' as const } })),
          },
        },
        window: { kind: 'combat', phase: 'minion', order: ['A', 'B'], cursor: 1, passes: 0 },
      });
    const b = [wait('B', 'combat')];
    expect(promptFor(combat('range'), 'B', b, who, name)?.text).toBe(
      'Combat, Round 1 · Range: maneuver, play a card or pass (long range)',
    );
    expect(promptFor(combat('strikes', [{ minion: 'm1' }]), 'B', b, who, name)?.text).toBe(
      'Combat, Round 1 · Strikes: choose a strike',
    );
    expect(promptFor(combat('strikes', [{ minion: 'm2' }]), 'B', b, who, name)?.text).toBe(
      'Combat, Round 1 · Strikes: play a card or pass',
    );
    expect(promptFor(combat('range'), 'C', b, who, name)?.text).toBe(
      'Waiting on Bob (combat, Round 1 · Range)',
    );
    // Damage about to land on Bob's minion; then the presses.
    const hurt = combat('range');
    const c = hurt.action?.combat;
    if (!c) throw new Error('no combat');
    const damage = {
      ...hurt,
      action: {
        ...bleed,
        stage: 'combat' as const,
        combat: {
          ...c,
          step: 'damage' as const,
          pending: { m2: { by: 'm1', normal: 2, aggravated: 0, prevented: 0 } },
        },
      },
    };
    expect(promptFor(damage, 'B', b, who, name)?.text).toBe(
      'Combat, Round 1 · Damage: prevent damage, play a card or pass',
    );
    const press = {
      ...damage,
      action: { ...damage.action, combat: { ...c, step: 'press' as const } },
    };
    expect(promptFor(press, 'B', b, who, name)?.text).toBe(
      'Combat, Round 1 · Press: press, play a card or pass',
    );
  });

  it('says nothing before the game starts', () => {
    expect(promptFor({} as GameState, 'A', [], who, name)).toBeUndefined();
  });
});
