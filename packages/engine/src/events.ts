/**
 * Events (architecture §4.2). The server stores full events; `projectEvent` redacts them per
 * viewer. Every random outcome (shuffle order, fresh instance IDs) is recorded here, so `evolve`
 * is deterministic and replay needs no RNG.
 */
import type { BloodHolder } from './commands.ts';
import type {
  ActionState,
  ActorRef,
  CardId,
  Counter,
  Format,
  GameId,
  GameSettings,
  ImpulseWindow,
  InstanceId,
  Instant,
  Phase,
  Turn,
  UserId,
  ZoneId,
} from './model.ts';
import type { SeatId, TurnDirection } from './seating.ts';

export interface EventMeta {
  seq: number;
  at: Instant;
  by: ActorRef;
}

/** A card moving to a new instance ID. `cardId` is stripped for viewers who can't see it. */
export interface Rekey {
  id: InstanceId;
  newId: InstanceId;
  cardId?: CardId;
}

export type EventBody =
  | {
      type: 'GameStarted';
      gameId: GameId;
      format: Format;
      settings: GameSettings;
      seats: { id: SeatId; user: UserId }[];
      /** Every card, listed in zone order (top first). */
      cards: { id: InstanceId; cardId?: CardId; owner: SeatId; zone: ZoneId }[];
    }
  | {
      type: 'CardMoved';
      card: InstanceId;
      from: ZoneId;
      to: ZoneId;
      position: 'top' | 'bottom';
      faceDown: boolean;
      /** Present when the card is re-keyed (entering a hidden zone or turning face down). */
      newId?: InstanceId;
      cardId?: CardId;
      /** Played from the hand (PlayCard), rather than moved. */
      played?: true;
    }
  | { type: 'CardsDrawn'; seat: SeatId; from: 'library' | 'crypt'; cards: Rekey[] }
  | {
      type: 'ZoneShuffled';
      zone: ZoneId;
      /** The zone's new contents, all freshly keyed, top first. */
      ids: InstanceId[];
      /** Old ID for each new one. Private: only viewers who can see the zone get it. */
      from?: InstanceId[];
    }
  | {
      type: 'CardFlipped';
      card: InstanceId;
      faceDown: boolean;
      newId?: InstanceId;
      cardId?: CardId;
    }
  | { type: 'CardLocked'; card: InstanceId; locked: boolean }
  | { type: 'CardContested'; card: InstanceId; contested: boolean }
  | { type: 'CounterAdjusted'; card: InstanceId; counter: Counter; delta: number }
  | { type: 'PoolAdjusted'; seat: SeatId; delta: number }
  | { type: 'VpAdjusted'; seat: SeatId; delta: number }
  | { type: 'BloodTransferred'; from: BloodHolder; to: BloodHolder; amount: number }
  | { type: 'CardAttached'; card: InstanceId; to?: InstanceId }
  | { type: 'CardRevealed'; card: InstanceId; cardId?: CardId }
  | { type: 'JudgeRevealed'; card: InstanceId; cardId?: CardId }
  | { type: 'EdgeSet'; seat?: SeatId }
  | { type: 'TurnDirectionSet'; direction: TurnDirection }
  | { type: 'PhaseAdvanced'; turn: Turn }
  | { type: 'PlayerReplaced'; seat: SeatId; user: UserId }
  /** `phases` is private to the seat. */
  | { type: 'AutoPassSet'; seat: SeatId; phases?: Phase[] }
  | { type: 'WindowOpened'; window: ImpulseWindow }
  | { type: 'Passed'; seat: SeatId; auto?: true }
  /** A card play returned the impulse to the acting Methuselah and voided the passes. */
  | { type: 'ImpulseReset' }
  | { type: 'WindowClosed' }
  | { type: 'ActionDeclared'; action: ActionState }
  | { type: 'BlockAttempted'; seat: SeatId; minion: InstanceId }
  | { type: 'BlockWithdrawn'; seat: SeatId }
  | { type: 'ActionBlocked'; blocker: InstanceId }
  | { type: 'ActionResolving' }
  | {
      type: 'ActionEnded';
      outcome: 'success' | 'failure' | 'blocked' | 'cancelled';
    };

export type EventType = EventBody['type'];
export type GameEvent = EventMeta & EventBody;
