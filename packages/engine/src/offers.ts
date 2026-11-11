/**
 * What a player can do right now (architecture §4.3, UX-03): the offers behind the action
 * toolbar. Computed from the player's own projected view, so it runs the same on clients and on
 * the server. Choosing an offer walks its steps (highlighting only the candidates); `build` turns
 * the choices into a command.
 */
import { type CardCatalog, titleBallots, titleVotes } from './catalog.ts';
import type { ClientCommand } from './commands.ts';
import { combatantOf, impulseHolder, isHolding, seatRefs } from './flow.ts';
import {
  type ActionKind,
  type CardId,
  COMBAT_STEPS,
  type GameState,
  type InstanceId,
  type PHASES,
} from './model.ts';
import { prey, type SeatId } from './seating.ts';
import { canWithdraw } from './withdrawal.ts';
import { zoneCards, zoneId } from './zones.ts';

export type OfferStep =
  | { kind: 'card'; label: string; candidates: readonly InstanceId[]; optional?: boolean }
  | { kind: 'seat'; label: string; candidates: SeatId[]; default?: SeatId }
  | { kind: 'amount'; label: string; min: number; default: number }
  | { kind: 'toggle'; label: string; default: boolean }
  | {
      kind: 'choice';
      label: string;
      options: readonly { value: string; label: string }[];
      default?: string;
    }
  | { kind: 'text'; label: string; optional?: boolean };

export type StepValue = InstanceId | SeatId | number | boolean | undefined;

export interface Offer {
  id: string;
  label: string;
  /** The offer the toolbar should highlight. */
  primary?: boolean;
  steps: OfferStep[];
  /**
   * Reveals information or affects other players, so the UI asks for confirmation before sending
   * (GAME-11).
   */
  confirm: boolean;
  /** What confirming it means, shown with the confirmation. */
  explain?: string;
  build(values: StepValue[]): ClientCommand;
}

const ACTION_OFFERS: {
  kind: ActionKind;
  label: string;
  cardTypes?: string[];
  needsCard?: boolean;
}[] = [
  { kind: 'bleed', label: 'Bleed', cardTypes: ['Action'] },
  { kind: 'hunt', label: 'Hunt' },
  { kind: 'political', label: 'Political action', cardTypes: ['Political Action'] },
  { kind: 'equip', label: 'Equip', cardTypes: ['Equipment'], needsCard: true },
  { kind: 'recruit', label: 'Recruit ally', cardTypes: ['Ally'], needsCard: true },
  { kind: 'employ', label: 'Employ retainer', cardTypes: ['Retainer'], needsCard: true },
  { kind: 'other', label: 'Other action', cardTypes: ['Action'] },
];

const PHASE_LABELS: Record<(typeof PHASES)[number], string> = {
  unlock: 'unlock',
  master: 'master',
  minion: 'minion',
  influence: 'influence',
  discard: 'discard',
};

export function availableActions(view: GameState, seat: SeatId, catalog: CardCatalog): Offer[] {
  if (view.status !== 'active') return [];
  const me = view.seats.find((s) => s.id === seat);
  if (!me || me.ousted || me.withdrawn) return [];
  const offers: Offer[] = [];
  const turn = view.turn;
  const myTurn = turn?.seat === seat;
  const action = view.action;
  const window = view.window;
  const hand = zoneCards(view, zoneId(seat, 'hand'));
  const ready = zoneCards(view, zoneId(seat, 'ready')).filter(
    (id) => view.cards[id]?.attachedTo === undefined,
  );
  const unlocked = ready.filter((id) => !view.cards[id]?.locked);
  // Public override sources: my face-up cards in play (docs/flow.md, "Overrides").
  const inPlay = (['ready', 'torpor'] as const)
    .flatMap((z) => zoneCards(view, zoneId(seat, z)))
    .filter((id) => {
      const c = view.cards[id];
      return c && c.controller === seat && !c.faceDown;
    });
  const sourceLabel = view.settings.tournament
    ? 'Card that allows it (required unless it is the action card)'
    : 'Card that allows it';
  const ofType = (types: string[] | undefined) =>
    types ? hand.filter((id) => hasType(view.cards[id]?.cardId, types, catalog)) : hand;
  const v = (values: StepValue[], i: number) => values[i];
  const id = (values: StepValue[], i: number) => v(values, i) as InstanceId;

  const playCard = (label: string, candidates: readonly InstanceId[], primary = false): Offer => ({
    id: 'play',
    label,
    primary,
    confirm: true,
    steps: [{ kind: 'card', label: 'Card to play', candidates }],
    build: (values) => ({ type: 'PlayCard', card: id(values, 0) }),
  });

  if (window?.kind === 'combat' && action?.combat) {
    return combatOffers(view, seat, { hand, inPlay, playCard });
  }
  if (window?.kind === 'polling' && action?.referendum) {
    return pollingOffers(view, seat, catalog, { hand, inPlay, ready, playCard });
  }
  // Before votes: anyone may abstain from the polling to come (M6.5, R4).
  const abstain: Offer[] =
    window?.kind === 'referendum' &&
    window.order.includes(seat) &&
    !action?.referendum?.abstaining?.includes(seat)
      ? [ABSTAIN]
      : [];

  if (window) {
    if (impulseHolder(view) !== seat) {
      // Ask the table to wait, so the engine doesn't pass for you when the impulse arrives.
      const canHold = window.order.includes(seat) && window.order[0] !== seat;
      if (!canHold || isHolding(view, seat)) return abstain;
      return [
        {
          id: 'hold',
          label: 'Hold',
          confirm: false,
          steps: [],
          build: () => ({ type: 'Hold' }),
        },
        ...abstain,
      ];
    }
    const canBlock =
      window.kind === 'blocks' &&
      action &&
      !action.blockAttempt &&
      action.eligible.includes(seat) &&
      !action.declined.includes(seat);
    if (canBlock && unlocked.length) {
      offers.push({
        id: 'block',
        label: 'Block',
        primary: true,
        confirm: true,
        steps: [{ kind: 'card', label: 'Blocking minion', candidates: unlocked }],
        build: (values) => ({ type: 'Block', minion: id(values, 0) }),
      });
    }
    // Not an eligible blocker: a card effect may still allow a block attempt.
    const canOverride =
      window.kind === 'blocks' &&
      action &&
      !action.blockAttempt &&
      action.seat !== seat &&
      !action.eligible.includes(seat) &&
      !action.declined.includes(seat);
    if (canOverride && unlocked.length) {
      offers.push({
        id: 'block-override',
        label: 'Block (card effect)…',
        confirm: true,
        steps: [
          {
            kind: 'card',
            label: sourceLabel,
            candidates: [...ofType(['Reaction']), ...inPlay],
            optional: !view.settings.tournament,
          },
          { kind: 'card', label: 'Blocking minion', candidates: unlocked },
        ],
        build: (values) => {
          const source = v(values, 0);
          return {
            type: 'Block',
            minion: id(values, 1),
            override: typeof source === 'string' ? { source } : {},
          };
        },
      });
    }
    if (action?.blockAttempt?.seat === seat) {
      offers.push({
        id: 'withdraw',
        label: 'Withdraw block',
        confirm: false,
        steps: [],
        build: () => ({ type: 'WithdrawBlock' }),
      });
    }
    if (hand.length) offers.push(playCard('Play a card', hand));
    offers.push({
      id: 'pass',
      label: canBlock ? 'Don’t block' : 'Pass',
      primary: !canBlock,
      confirm: false,
      steps: [],
      build: () => ({ type: 'Pass' }),
    });
    return [...offers, ...abstain];
  }

  if (action) {
    const mine = action.seat === seat;
    if (mine && action.stage === 'resolution') {
      const steps: OfferStep[] = [];
      if (action.kind === 'bleed')
        steps.push({ kind: 'amount', label: 'Bleed amount', min: 0, default: 1 });
      if (action.kind === 'hunt')
        steps.push({ kind: 'amount', label: 'Blood gained', min: 0, default: 1 });
      if (action.kind === 'bleed')
        steps.push({ kind: 'toggle', label: 'Take the Edge', default: !me.hasEdge });
      // A political action's terms are chosen as it succeeds (M6.5, R1).
      const political = action.kind === 'political';
      if (political) steps.push({ kind: 'text', label: 'Terms of the referendum', optional: true });
      offers.push({
        id: 'success',
        label: political ? 'Successful: call the referendum' : 'Successful',
        primary: true,
        confirm: true,
        steps,
        build: (values) => {
          const cmd: Extract<ClientCommand, { type: 'ResolveAction' }> = {
            type: 'ResolveAction',
            outcome: 'success',
          };
          if (political) {
            const terms = typeof values[0] === 'string' ? values[0].trim() : '';
            if (terms) cmd.terms = terms;
            return cmd;
          }
          if (typeof values[0] === 'number') cmd.amount = values[0];
          if (values[1] === true) cmd.edge = true;
          return cmd;
        },
      });
      offers.push({
        id: 'failure',
        label: 'Unsuccessful',
        confirm: true,
        steps: [],
        build: () => ({ type: 'ResolveAction', outcome: 'failure' }),
      });
      // An action that enters combat: the acting minion fights a minion of another Methuselah.
      const opponents = view.seats
        .filter((x) => x.id !== seat && !x.ousted && !x.withdrawn)
        .flatMap((x) => zoneCards(view, zoneId(x.id, 'ready')))
        .filter((m) => view.cards[m]?.attachedTo === undefined);
      if (opponents.length) {
        offers.push({
          id: 'enter-combat',
          label: 'Enter combat…',
          confirm: true,
          steps: [{ kind: 'card', label: 'Minion to fight', candidates: opponents }],
          build: (values) => ({
            type: 'ResolveAction',
            outcome: 'combat',
            opponent: id(values, 0),
          }),
        });
      }
      // Diablerie is an action of its own ("other"): its blood hunt comes as it resolves (M6.5b).
      if (action.kind === 'other') {
        offers.push({
          id: 'blood-hunt',
          label: 'Call a blood hunt…',
          confirm: true,
          explain: 'A referendum on burning the diablerist.',
          steps: [{ kind: 'card', label: 'Diablerist', candidates: ready, optional: true }],
          build: (values) => {
            const m = v(values, 0);
            return typeof m === 'string'
              ? { type: 'CallBloodHunt', minion: m }
              : { type: 'CallBloodHunt' };
          },
        });
      }
    }
    const blockerSeat = action.blocker ? view.cards[action.blocker]?.controller : undefined;
    if (action.stage === 'combat' && (mine || blockerSeat === seat)) {
      offers.push({
        id: 'endcombat',
        label: 'End combat',
        primary: true,
        confirm: false,
        steps: [],
        build: () => ({ type: 'EndCombat' }),
      });
    }
    if (hand.length) offers.push(playCard('Play a card', hand));
    if (mine) {
      offers.push({
        id: 'cancel',
        label: 'Cancel action',
        confirm: true,
        steps: [],
        build: () => ({ type: 'CancelAction' }),
      });
    }
    return offers;
  }

  if (myTurn && turn.phase === 'minion' && unlocked.length) {
    const others = view.seats.filter((s) => s.id !== seat && !s.ousted && !s.withdrawn);
    for (const a of ACTION_OFFERS) {
      const cards = ofType(a.cardTypes);
      if (a.needsCard && !cards.length) continue;
      if (a.kind === 'bleed' && !others.length) continue;
      const steps: OfferStep[] = [{ kind: 'card', label: 'Acting minion', candidates: unlocked }];
      if (a.cardTypes && (a.needsCard || cards.length)) {
        steps.push({
          kind: 'card',
          label: a.needsCard ? 'Card' : 'Action card (optional)',
          candidates: cards,
          optional: !a.needsCard,
        });
      }
      offers.push({
        id: `action:${a.kind}`,
        label: a.label,
        primary: a.kind === 'bleed',
        confirm: true,
        steps,
        build: (values) => {
          const cmd: Extract<ClientCommand, { type: 'DeclareAction' }> = {
            type: 'DeclareAction',
            kind: a.kind,
            minion: id(values, 0),
          };
          const card = v(values, 1);
          if (typeof card === 'string') cmd.card = card;
          return cmd;
        },
      });
    }
    // Bleeding anyone but your prey needs a card effect: the action card, or one in play.
    const myPrey = prey(seatRefs(view), seat);
    const elsewhere = others.filter((s) => s.id !== myPrey).map((s) => s.id);
    if (elsewhere.length) {
      const actionCards = ofType(['Action']);
      const steps: OfferStep[] = [{ kind: 'card', label: 'Acting minion', candidates: unlocked }];
      if (actionCards.length) {
        steps.push({
          kind: 'card',
          label: 'Action card (optional)',
          candidates: actionCards,
          optional: true,
        });
      }
      steps.push(
        {
          kind: 'card',
          label: actionCards.length ? `${sourceLabel}, if not the action card` : sourceLabel,
          candidates: inPlay,
          optional: true,
        },
        { kind: 'seat', label: 'Bleed whom?', candidates: elsewhere },
      );
      offers.push({
        id: 'action:bleed-other',
        label: 'Bleed another Methuselah…',
        confirm: true,
        steps,
        build: (values) => {
          let i = 0;
          const cmd: Extract<ClientCommand, { type: 'DeclareAction' }> = {
            type: 'DeclareAction',
            kind: 'bleed',
            minion: id(values, i++),
            override: {},
          };
          const card = actionCards.length ? v(values, i++) : undefined;
          if (typeof card === 'string') cmd.card = card;
          const source = v(values, i++);
          if (typeof source === 'string') cmd.override = { source };
          cmd.target = v(values, i) as SeatId;
          return cmd;
        },
      });
    }
  }

  if (myTurn && turn.phase === 'master') {
    const masters = ofType(['Master']);
    if (masters.length) offers.push(playCard('Play a master card', masters));
  }
  if (!myTurn || turn.phase !== 'master') {
    if (hand.length) offers.push(playCard('Play a card', hand));
  }
  // Only when it's allowed (GAME-09): otherwise there's no sign of it.
  if (canWithdraw(view, seat)) {
    offers.push({
      id: 'withdraw',
      label: 'Withdraw…',
      confirm: true,
      explain:
        'You’ll leave the game at the start of your next turn, with ½ VP, if until then you lose or spend no pool, none of your vampires loses or spends blood, and none of your minions enters combat.',
      steps: [],
      build: () => ({ type: 'Withdraw' }),
    });
  }
  if (myTurn) {
    offers.push({
      id: 'advance',
      label: turn.phase === 'discard' ? 'End turn' : `End ${PHASE_LABELS[turn.phase]} phase`,
      primary: !offers.some((o) => o.primary),
      confirm: false,
      steps: [],
      build: () => ({ type: 'AdvancePhase' }),
    });
  }
  return offers;
}

/** Without type data (e.g. a minimal catalog), every card qualifies. */
function hasType(cardId: CardId | undefined, types: string[], catalog: CardCatalog): boolean {
  if (!cardId) return false;
  const info = catalog.get(cardId);
  if (!info?.types) return true;
  return info.types.some((t) => types.includes(t));
}

const ABSTAIN: Offer = {
  id: 'abstain',
  label: 'Abstain',
  confirm: true,
  explain: 'You’ll pass the rest of this referendum, casting no more votes.',
  steps: [],
  build: () => ({ type: 'Abstain' }),
};

const SIDES = [
  { value: 'for', label: 'For' },
  { value: 'against', label: 'Against' },
] as const;
const sideStep: OfferStep = { kind: 'choice', label: 'Vote', options: SIDES, default: 'for' };
const sideOf = (v: StepValue) => (v === 'against' ? 'against' : 'for');

/**
 * Offers in a referendum's polling step (docs/m6-plan.md M6.5): the seat holding the impulse
 * casts from each of its sources, plays or uses cards, or passes; anyone may abstain.
 */
function pollingOffers(
  view: GameState,
  seat: SeatId,
  catalog: CardCatalog,
  my: {
    hand: readonly InstanceId[];
    inPlay: readonly InstanceId[];
    ready: readonly InstanceId[];
    playCard: (label: string, candidates: readonly InstanceId[], primary?: boolean) => Offer;
  },
): Offer[] {
  const a = view.action;
  const r = a?.referendum;
  if (!a || !r || r.abstaining?.includes(seat)) return [];
  if (impulseHolder(view) !== seat) return [ABSTAIN];
  const offers: Offer[] = [];
  // The calling card stays in the caller's hand until the action ends: it's not theirs to play.
  const hand = my.hand.filter((id) => id !== a.card);
  const name = (id: InstanceId) => {
    const cardId = view.cards[id]?.cardId;
    return (cardId && catalog.get(cardId)?.name) || 'a card';
  };
  const cast = new Set(r.votes.map((v) => v.minion));
  const minions = my.ready.filter((id) => {
    const info = catalog.get(view.cards[id]?.cardId ?? '');
    return !info || info.kind === 'crypt' || !!info.types?.includes('Ally');
  });
  // Each titled vampire not yet cast, with its title's votes.
  for (const m of minions) {
    const title = catalog.get(view.cards[m]?.cardId ?? '')?.title;
    const n = titleVotes(title);
    const b = titleBallots(title);
    if ((!n && !b) || cast.has(m) || r.cancelled?.includes(m)) continue;
    offers.push({
      id: `vote:${m}`,
      label: `Vote with ${name(m)} (${n || `${b} ballot`})…`,
      primary: offers.length === 0,
      confirm: true,
      steps: [sideStep],
      build: (values) => ({
        type: 'CastVotes',
        source: 'minion',
        minion: m,
        side: sideOf(values[0]),
      }),
    });
  }
  if (minions.length) {
    offers.push({
      id: 'vote:minion',
      label: 'Votes from a minion (card effect)…',
      confirm: true,
      steps: [
        { kind: 'card', label: 'Minion voting', candidates: minions },
        { kind: 'amount', label: 'Votes', min: 1, default: 1 },
        sideStep,
      ],
      build: (values) => ({
        type: 'CastVotes',
        source: 'minion',
        minion: values[0] as InstanceId,
        votes: values[1] as number,
        side: sideOf(values[2]),
      }),
    });
  }
  if (view.seats.find((s) => s.id === seat)?.hasEdge) {
    offers.push({
      id: 'vote:edge',
      label: 'Burn the Edge for a vote…',
      confirm: true,
      steps: [sideStep],
      build: (values) => ({ type: 'CastVotes', source: 'edge', side: sideOf(values[0]) }),
    });
  }
  const mine = r.votes.filter((v) => v.seat === seat);
  const calling = a.seat === seat && a.card !== undefined && r.kind !== 'blood-hunt';
  if (calling && !mine.some((v) => v.source === 'card')) {
    offers.push({
      id: 'vote:card',
      label: 'The calling card’s vote…',
      confirm: true,
      steps: [sideStep],
      build: (values) => ({ type: 'CastVotes', source: 'card', side: sideOf(values[0]) }),
    });
  }
  const political = hand.filter((id) =>
    catalog.get(view.cards[id]?.cardId ?? '')?.types?.includes('Political Action'),
  );
  if (!calling && political.length && !mine.some((v) => v.source === 'burned')) {
    offers.push({
      id: 'vote:burn',
      label: 'Burn a political action card for a vote…',
      confirm: true,
      steps: [{ kind: 'card', label: 'Card to burn', candidates: political }, sideStep],
      build: (values) => ({
        type: 'CastVotes',
        source: 'burned',
        card: values[0] as InstanceId,
        side: sideOf(values[1]),
      }),
    });
  }
  offers.push({
    id: 'vote:other',
    label: 'Other votes…',
    confirm: true,
    steps: [
      { kind: 'amount', label: 'Votes', min: 1, default: 1 },
      sideStep,
      {
        kind: 'card',
        label: 'Card they come from',
        candidates: [...hand, ...my.inPlay],
        optional: true,
      },
      { kind: 'text', label: 'Note', optional: true },
    ],
    build: (values) => {
      const note = typeof values[3] === 'string' ? values[3].trim() : '';
      return {
        type: 'CastVotes',
        source: 'other',
        votes: values[0] as number,
        side: sideOf(values[1]),
        ...(typeof values[2] === 'string' ? { card: values[2] } : {}),
        ...(note ? { note } : {}),
      };
    },
  });
  if (hand.length) offers.push(my.playCard('Play a card', hand));
  if (my.inPlay.length) {
    offers.push({
      id: 'use',
      label: 'Use a card…',
      confirm: true,
      steps: [
        { kind: 'card', label: 'Card to use', candidates: my.inPlay },
        { kind: 'text', label: 'What it does', optional: true },
      ],
      build: (values) => {
        const note = typeof values[1] === 'string' ? values[1].trim() : '';
        return { type: 'UseCard', card: values[0] as InstanceId, ...(note ? { note } : {}) };
      },
    });
  }
  offers.push({
    id: 'pass',
    label: 'Pass',
    primary: !offers.some((o) => o.primary),
    confirm: false,
    steps: [],
    build: () => ({ type: 'Pass' }),
  });
  // Kateline Nadasdy, Demonstration: a vampire made to abstain (rules-qa 76.6, 77.14).
  const voters = view.seats
    .filter((x) => !x.ousted && !x.withdrawn)
    .flatMap((x) => zoneCards(view, zoneId(x.id, 'ready')))
    .filter((m) => view.cards[m]?.attachedTo === undefined && !r.cancelled?.includes(m));
  if (voters.length) {
    offers.push({
      id: 'cancel-votes',
      label: 'Make a vampire abstain…',
      confirm: true,
      steps: [
        { kind: 'card', label: 'Vampire', candidates: voters },
        {
          kind: 'card',
          label: 'Card it comes from',
          candidates: [...hand, ...my.inPlay],
          optional: true,
        },
      ],
      build: (values) => ({
        type: 'CancelVotes',
        minion: values[0] as InstanceId,
        ...(typeof values[1] === 'string' ? { source: values[1] } : {}),
      }),
    });
  }
  // The caller settles it at once, for cards that do (Yoruba Shrine, Fakir al Sidi).
  if (a.seat === seat) {
    offers.push({
      id: 'end-referendum',
      label: 'End the referendum…',
      confirm: true,
      steps: [
        {
          kind: 'choice',
          label: 'Result',
          options: [
            { value: 'pass', label: 'It passes' },
            { value: 'fail', label: 'It fails' },
          ],
          default: 'fail',
        },
        { kind: 'text', label: 'Why (the card that settles it)', optional: true },
      ],
      build: (values) => {
        const note = typeof values[1] === 'string' ? values[1].trim() : '';
        return { type: 'EndReferendum', passed: values[0] === 'pass', ...(note ? { note } : {}) };
      },
    });
  }
  offers.push(ABSTAIN);
  return offers;
}

const DAMAGE_TYPES = [
  { value: 'normal', label: 'Normal' },
  { value: 'R', label: 'Ranged (R)' },
  { value: 'A', label: 'Aggravated' },
  { value: 'RA', label: 'Ranged, aggravated' },
] as const;

/**
 * Offers in a combat step (docs/flow.md, "Combat"), for the two combatants' Methuselahs: the
 * moves of the step for whoever holds the impulse, standing passes and ending the combat for both.
 */
function combatOffers(
  view: GameState,
  seat: SeatId,
  my: {
    hand: readonly InstanceId[];
    inPlay: readonly InstanceId[];
    playCard: (label: string, candidates: readonly InstanceId[], primary?: boolean) => Offer;
  },
): Offer[] {
  const c = view.action?.combat;
  const minion = combatantOf(view, seat);
  if (!c || minion === undefined) return [];
  const offers: Offer[] = [];
  const sources = [...my.hand, ...my.inPlay];
  const source = (label: string, optional: boolean): OfferStep => ({
    kind: 'card',
    label,
    candidates: sources,
    optional,
  });
  const str = (values: StepValue[], i: number) =>
    typeof values[i] === 'string' ? (values[i] as string) : undefined;
  const at = COMBAT_STEPS.indexOf(c.step);
  // In an additional exchange, a combatant without an additional strike has nothing to choose.
  const sitsOut = !!c.exchange && !c.exchange.includes(minion);
  const struck = sitsOut || c.strikes.some((x) => x.minion === minion);
  if (impulseHolder(view) === seat) {
    // No minion maneuvers twice in a row.
    if (c.step === 'range' && c.lastManeuver !== minion) {
      const to = c.range === 'close' ? 'long' : 'close';
      offers.push({
        id: 'maneuver',
        label: `Maneuver to ${to}…`,
        confirm: true,
        steps: [source('Card it comes from', true)],
        build: (values) => {
          const src = str(values, 0);
          return src ? { type: 'Maneuver', to, source: src } : { type: 'Maneuver', to };
        },
      });
    }
    if (c.step === 'strikes' && !struck) {
      const strike = (
        id: string,
        label: string,
        kind: Extract<ClientCommand, { type: 'Strike' }>['kind'],
        steps: OfferStep[],
        build: (values: StepValue[]) => Partial<Extract<ClientCommand, { type: 'Strike' }>>,
        primary = false,
      ): Offer => ({
        id: `strike:${id}`,
        label,
        primary,
        confirm: true,
        steps,
        build: (values) => ({ type: 'Strike', kind, ...build(values) }),
      });
      const withSource = (values: StepValue[], i: number) => {
        const src = str(values, i);
        return src ? { source: src } : {};
      };
      offers.push(
        strike(
          'hand',
          'Hand strike',
          'hand',
          [{ kind: 'amount', label: 'Damage', min: 0, default: 1 }],
          (values) => ({ amount: typeof values[0] === 'number' ? values[0] : 1 }),
          true,
        ),
        strike(
          'damage',
          'Strike with a card…',
          'damage',
          [
            source('Card it comes from', false),
            { kind: 'amount', label: 'Damage', min: 0, default: 1 },
            { kind: 'choice', label: 'Damage type', options: DAMAGE_TYPES, default: 'normal' },
            { kind: 'toggle', label: 'First strike', default: false },
          ],
          (values) => {
            const type = str(values, 2) ?? 'normal';
            return {
              ...withSource(values, 0),
              amount: typeof values[1] === 'number' ? values[1] : 1,
              ...(type.includes('R') ? { ranged: true } : {}),
              ...(type.includes('A') ? { aggravated: true } : {}),
              ...(values[3] === true ? { first: true } : {}),
            };
          },
        ),
        strike('dodge', 'Dodge…', 'dodge', [source('Card it comes from', true)], (values) =>
          withSource(values, 0),
        ),
        strike(
          'combat-ends',
          'Combat ends…',
          'combat-ends',
          [source('Card it comes from', true)],
          (values) => withSource(values, 0),
        ),
        strike(
          'steal-blood',
          'Steal blood…',
          'steal-blood',
          [
            source('Card it comes from', true),
            { kind: 'amount', label: 'Blood', min: 0, default: 1 },
          ],
          (values) => ({
            ...withSource(values, 0),
            amount: typeof values[1] === 'number' ? values[1] : 1,
          }),
        ),
        strike('none', 'No strike', 'none', [], () => ({})),
      );
    }
    const hit = c.pending?.[minion];
    if (c.step === 'damage' && hit && hit.normal + hit.aggravated > hit.prevented) {
      offers.push({
        id: 'prevent',
        label: 'Prevent damage…',
        confirm: true,
        steps: [
          {
            kind: 'amount',
            label: 'Damage to prevent',
            min: 1,
            default: hit.normal + hit.aggravated - hit.prevented,
          },
          source('Card it comes from', true),
        ],
        build: (values) => {
          const src = str(values, 1);
          const points = typeof values[0] === 'number' ? values[0] : 1;
          return src ? { type: 'Prevent', points, source: src } : { type: 'Prevent', points };
        },
      });
    }
    if (c.step === 'damage' && !c.ending && !c.additional?.includes(minion)) {
      offers.push({
        id: 'additional',
        label: 'Additional strike…',
        confirm: true,
        steps: [source('Card it comes from', true)],
        build: (values) => {
          const src = str(values, 0);
          return src ? { type: 'AdditionalStrike', source: src } : { type: 'AdditionalStrike' };
        },
      });
    }
    if (c.step === 'press' && c.presses?.at(-1)?.minion !== minion) {
      for (const mode of ['continue', 'end'] as const) {
        offers.push({
          id: `press:${mode}`,
          label: mode === 'continue' ? 'Press to continue…' : 'Press to end…',
          confirm: true,
          steps: [source('Card it comes from', true)],
          build: (values) => {
            const src = str(values, 0);
            return src ? { type: 'Press', mode, source: src } : { type: 'Press', mode };
          },
        });
      }
    }
    if (my.hand.length) offers.push(my.playCard('Play a card', my.hand));
    if (my.inPlay.length) {
      offers.push({
        id: 'use',
        label: 'Use a card…',
        confirm: true,
        steps: [
          { kind: 'card', label: 'Card to use', candidates: my.inPlay },
          { kind: 'text', label: 'What it does', optional: true },
        ],
        build: (values) => {
          const note = str(values, 1);
          return { type: 'UseCard', card: values[0] as InstanceId, ...(note ? { note } : {}) };
        },
      });
    }
    if (c.step !== 'strikes' || struck) {
      offers.push({
        id: 'pass',
        label: 'Pass',
        primary: c.step !== 'strikes',
        confirm: false,
        steps: [],
        build: () => ({ type: 'Pass' }),
      });
    }
  }
  const until = c.passUntil?.[seat];
  if (at < COMBAT_STEPS.indexOf('strikes') && until !== 'strikes') {
    offers.push({
      id: 'pass-strikes',
      label: 'Pass to strikes',
      confirm: false,
      steps: [],
      build: () => ({ type: 'PassUntil', until: 'strikes' }),
    });
  }
  if (at > COMBAT_STEPS.indexOf('strikes') && until !== 'end') {
    offers.push({
      id: 'pass-end',
      label: 'Pass to the end of the round',
      confirm: false,
      steps: [],
      build: () => ({ type: 'PassUntil', until: 'end' }),
    });
  }
  offers.push({
    id: 'endcombat',
    label: 'End combat',
    confirm: true,
    explain: 'Ends the combat at once, whatever step it is at.',
    steps: [],
    build: () => ({ type: 'EndCombat' }),
  });
  return offers;
}
