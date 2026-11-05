/**
 * Events (architecture §4.2). The server stores full events; `projectEvent` redacts them per
 * viewer. Every random outcome (shuffle order, fresh instance IDs) is recorded here, so `evolve`
 * is deterministic and replay needs no RNG.
 */
import type { BloodHolder } from './commands.ts';
import type { WaitKind } from './flow.ts';
import type {
  ActionState,
  ActorRef,
  CardId,
  Counter,
  Format,
  GameEndReason,
  GameId,
  GameSettings,
  ImpulseWindow,
  InstanceId,
  Instant,
  JudgeCall,
  Override,
  Phase,
  Ruling,
  StopRule,
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
      /** Every card, listed in zone order (top first), with the opening draw already dealt. */
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
      /**
       * Who controls the card when it isn't the seat whose zone it's in: a master card played on
       * another Methuselah's minion stays under the control of whoever played it.
       */
      controller?: SeatId;
      /** Moved because this seat was ousted: removed from the game, or burned (GAME-08). */
      ousted?: SeatId;
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
  /** The seat's player opened the game, or has been gone long enough to count as away. */
  | { type: 'PlayerPresent'; seat: SeatId }
  | { type: 'PlayerAbsent'; seat: SeatId }
  /** `seat` is missing for a judge's pause. */
  | { type: 'Paused'; seat?: SeatId; until: Instant }
  | { type: 'Resumed' }
  /** Half the time for a decision has gone by while its player is away. */
  | { type: 'DeadlineReminded'; seat: SeatId }
  /** The time for a decision ran out. Nothing is done for the player; a judge steps in (GAME-18). */
  | { type: 'DeadlineExpired'; seat: SeatId; kind: WaitKind }
  /** The table timer ran out (Tournament Rules 3.1.1). */
  | { type: 'TimeLimitReached' }
  /** A judge call opened; its ID is `c<seq>` of this event. */
  | { type: 'JudgeCalled'; call: Omit<JudgeCall, 'id' | 'openedAt' | 'claimedBy'> }
  | { type: 'JudgeCallClaimed'; id: string; judge: UserId }
  /** `auto`: the call settled itself (an away player came back and decided). */
  | { type: 'JudgeCallResolved'; id: string; ruling: Ruling; note?: string; auto?: true }
  | { type: 'DeadlineExtended'; seat: SeatId; ms: number }
  | { type: 'TimeExtended'; ms: number }
  /** The game is over: `awards` are the VP for surviving it (last standing, or a timeout's half). */
  | {
      type: 'GameEnded';
      reason: GameEndReason;
      awards: { seat: SeatId; vp: number }[];
      winner?: SeatId;
      gameWin?: SeatId;
      note?: string;
    }
  | { type: 'EndProposed'; seat: SeatId }
  | { type: 'EndAgreed'; seat: SeatId }
  | { type: 'EndDeclined'; seat: SeatId }
  /** `phases` is private to the seat. */
  | { type: 'AutoPassSet'; seat: SeatId; phases?: Phase[] }
  /** `stops` is private to the seat. */
  | { type: 'StopsSet'; seat: SeatId; stops?: StopRule[] }
  /** The seat holds the open window; public. */
  | { type: 'Held'; seat: SeatId }
  | { type: 'WindowOpened'; window: ImpulseWindow }
  | { type: 'Passed'; seat: SeatId; auto?: true }
  /** A card play returned the impulse to the acting Methuselah and voided the passes. */
  | { type: 'ImpulseReset' }
  | { type: 'WindowClosed' }
  | { type: 'ActionDeclared'; action: ActionState }
  | { type: 'BlockAttempted'; seat: SeatId; minion: InstanceId; override?: Override }
  | { type: 'BlockWithdrawn'; seat: SeatId }
  | { type: 'ActionBlocked'; blocker: InstanceId }
  | { type: 'ActionResolving' }
  | {
      type: 'ActionEnded';
      /** `ousted`: the acting Methuselah, the target or the blocker's was ousted (DQ9). */
      outcome: 'success' | 'failure' | 'blocked' | 'cancelled' | 'ousted';
    }
  /**
   * A Methuselah reached 0 pool and is out of the game (GAME-08). Their cards in play have already
   * gone to their owners' ash heaps. The predator gains VP and pool (no pool if ousted too).
   */
  | {
      type: 'Ousted';
      seat: SeatId;
      predator?: { seat: SeatId; vp: number; pool: number };
      /** Out by a judge's ruling rather than at 0 pool: nobody is rewarded. */
      disqualified?: true;
    };

export type EventType = EventBody['type'];
export type GameEvent = EventMeta & EventBody;
