/**
 * What a player can do right now (architecture §4.3, UX-03): the offers behind the action
 * toolbar. Computed from the player's own projected view, so it runs the same on clients and on
 * the server. Choosing an offer walks its steps (highlighting only the candidates); `build` turns
 * the choices into a command.
 */
import type { CardCatalog } from './catalog.ts';
import type { ClientCommand } from './commands.ts';
import { impulseHolder, isHolding, seatRefs } from './flow.ts';
import type { ActionKind, CardId, GameState, InstanceId, PHASES } from './model.ts';
import { prey, type SeatId } from './seating.ts';
import { canWithdraw } from './withdrawal.ts';
import { zoneCards, zoneId } from './zones.ts';

export type OfferStep =
  | { kind: 'card'; label: string; candidates: readonly InstanceId[]; optional?: boolean }
  | { kind: 'seat'; label: string; candidates: SeatId[]; default?: SeatId }
  | { kind: 'amount'; label: string; min: number; default: number }
  | { kind: 'toggle'; label: string; default: boolean };

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

  if (window) {
    if (impulseHolder(view) !== seat) {
      // Ask the table to wait, so the engine doesn't pass for you when the impulse arrives.
      const canHold = window.order.includes(seat) && window.order[0] !== seat;
      if (!canHold || isHolding(view, seat)) return [];
      return [
        {
          id: 'hold',
          label: 'Hold',
          confirm: false,
          steps: [],
          build: () => ({ type: 'Hold' }),
        },
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
    return offers;
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
      offers.push({
        id: 'success',
        label: 'Successful',
        primary: true,
        confirm: true,
        steps,
        build: (values) => {
          const cmd: Extract<ClientCommand, { type: 'ResolveAction' }> = {
            type: 'ResolveAction',
            outcome: 'success',
          };
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
