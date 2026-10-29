/**
 * Commands (architecture §4.2). Every input method (drag-and-drop, context menu, toolbar, console)
 * produces these same objects. M1 covers game setup, the primitives and player replacement; the
 * structured flow (actions, windows, decisions) arrives in M5.
 */
import type {
  CardId,
  Counter,
  Format,
  GameId,
  GameSettings,
  InstanceId,
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
  | { type: 'AdvancePhase' }
  /** Admin only, non-tournament games only (GAME-19). */
  | { type: 'ReplacePlayer'; seat: SeatId; user: UserId };

export type CommandType = Command['type'];
