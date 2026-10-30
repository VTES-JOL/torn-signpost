/**
 * Commands (architecture §4.2). Every input method (drag-and-drop, context menu, toolbar, console)
 * produces these same objects: game setup, the primitives, the structured flow (M5: phases, actions,
 * impulse windows) and player replacement.
 */
import type {
  ActionKind,
  CardId,
  Counter,
  Format,
  GameId,
  GameSettings,
  InstanceId,
  Phase,
  UserId,
  ZoneId,
} from './model.ts';
import type { SeatId, TurnDirection } from './seating.ts';

/** Where blood comes from or goes to: a seat's pool or the counters on a card. */
export type BloodHolder = { pool: SeatId } | { card: InstanceId };

export interface SeatSetup {
  id: SeatId;
  user: UserId;
  crypt: CardId[];
  library: CardId[];
}

export type Command =
  | {
      type: 'StartGame';
      gameId: GameId;
      format: Format;
      seats: SeatSetup[];
      settings?: Partial<GameSettings>;
    }
  | {
      type: 'MoveCard';
      card: InstanceId;
      to: ZoneId;
      /** Default: top for crypt/library, bottom (appended) elsewhere. */
      position?: 'top' | 'bottom';
      faceDown?: boolean;
    }
  | { type: 'Draw'; seat?: SeatId; from?: 'library' | 'crypt'; count?: number }
  | { type: 'Shuffle'; zone: ZoneId }
  | { type: 'Flip'; card: InstanceId }
  | { type: 'SetLocked'; card: InstanceId; locked: boolean }
  | { type: 'SetContested'; card: InstanceId; contested: boolean }
  | { type: 'AdjustCounter'; card: InstanceId; counter: Counter; delta: number }
  | { type: 'AdjustPool'; seat: SeatId; delta: number }
  | { type: 'AdjustVp'; seat: SeatId; delta: number }
  | { type: 'TransferBlood'; from: BloodHolder; to: BloodHolder; amount: number }
  /** Attach `card` to `to`, moving it into the host's zone if needed; no `to` detaches. */
  | { type: 'Attach'; card: InstanceId; to?: InstanceId }
  /** Show one of your own hidden cards to everyone. */
  | { type: 'Reveal'; card: InstanceId }
  /** A judge looks at a hidden card. Audited: every player sees that it happened (GAME-03). */
  | { type: 'JudgeReveal'; card: InstanceId }
  | { type: 'SetEdge'; seat?: SeatId }
  | { type: 'SetTurnDirection'; direction: TurnDirection }
  /** End the current phase; opens the end-of-phase pass round unless everyone auto-passes. */
  | { type: 'AdvancePhase' }
  /** Which end-of-phase pass rounds to pass automatically. */
  | { type: 'SetAutoPass'; phases: Phase[] }
  /** Declare a minion action; `card` is an action card from the hand. */
  | {
      type: 'DeclareAction';
      minion: InstanceId;
      kind: ActionKind;
      target?: SeatId;
      card?: InstanceId;
    }
  /** Pass the impulse. An eligible blocker's pass with no block attempt pending declines to block. */
  | { type: 'Pass' }
  | { type: 'Block'; minion: InstanceId }
  /** Give up a block attempt (e.g. not enough intercept). */
  | { type: 'WithdrawBlock' }
  /**
   * Play a card from the hand (GAME-06): to the ash heap by default, or into play, optionally
   * attached. Replaces it from the library unless `replace` is false. In a window it needs the
   * impulse, and returns the impulse to the acting Methuselah.
   */
  | {
      type: 'PlayCard';
      card: InstanceId;
      to?: 'ashHeap' | 'ready';
      attachTo?: InstanceId;
      replace?: boolean;
    }
  /** The acting Methuselah resolves an unblocked action; bleeds and hunts apply their amount. */
  | {
      type: 'ResolveAction';
      outcome: 'success' | 'failure';
      amount?: number;
      /** Take the Edge after a successful bleed. */
      edge?: boolean;
    }
  | { type: 'EndCombat' }
  | { type: 'CancelAction' }
  /** Admin only, non-tournament games only (GAME-19). */
  | { type: 'ReplacePlayer'; seat: SeatId; user: UserId };

export type CommandType = Command['type'];

/** Commands players, judges and admins send; only the server starts games. */
export type ClientCommand = Exclude<Command, { type: 'StartGame' }>;
