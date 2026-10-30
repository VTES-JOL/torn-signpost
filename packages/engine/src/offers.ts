/**
 * What a player can do right now (architecture §4.3, UX-03): the offers behind the action
 * toolbar. Computed from the player's own projected view, so it runs the same on clients and on
 * the server. Choosing an offer walks its steps (highlighting only the candidates); `build` turns
 * the choices into a command.
 */
import type { CardCatalog } from './catalog.ts';
import type { ClientCommand } from './commands.ts';
import { impulseHolder, seatRefs } from './flow.ts';
import type { ActionKind, CardId, GameState, InstanceId, PHASES } from './model.ts';
import { prey, type SeatId } from './seating.ts';
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
  build(values: StepValue[]): ClientCommand;
}

const ACTION_OFFERS: {
  kind: ActionKind;
  label: string;
  cardTypes?: string[];
  needsCard?: boolean;
}[] = [
  { kind: 'bleed', label: 'Bleed' },
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
    if (impulseHolder(view) !== seat) return [];
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
      const steps: OfferStep[] = [{ kind: 'card', label: 'Acting minion', candidates: unlocked }];
      if (a.kind === 'bleed' && others.length) {
        const def = prey(seatRefs(view), seat);
        steps.push({
          kind: 'seat',
          label: 'Bleed whom?',
          candidates: others.map((s) => s.id),
          ...(def ? { default: def } : {}),
        });
      }
      if (a.cardTypes) {
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
          let i = 1;
          if (a.kind === 'bleed' && others.length) cmd.target = v(values, i++) as SeatId;
          const card = a.cardTypes ? v(values, i) : undefined;
          if (typeof card === 'string') cmd.card = card;
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
