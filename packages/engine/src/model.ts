/**
 * Core game model (architecture §4.1). The game is modelled around seats: cards, zones, pool and
 * VP belong to a seat, and a user occupies a seat. The same `GameState` shape serves as the full
 * server state and as a redacted per-viewer view (`cardId` is missing on cards the viewer can't
 * see), so `evolve` runs unchanged on both.
 */
import type { SeatId, TurnDirection } from './seating.ts';

export type GameId = string;
export type UserId = string;
export type InstanceId = string;
export type CardId = string;
/** ISO-8601 timestamp. */
export type Instant = string;

export type Format = 'standard' | 'v5' | 'duel';

/** Per-seat zones (GAME-02). Index 0 of a zone is its top card. */
export const ZONE_NAMES = [
  'crypt',
  'library',
  'hand',
  'uncontrolled',
  'ready',
  'torpor',
  'ashHeap',
  'removed',
  'research',
] as const;
export type ZoneName = (typeof ZONE_NAMES)[number];
export type ZoneId = `${SeatId}:${ZoneName}`;

export const PHASES = ['unlock', 'master', 'minion', 'influence', 'discard'] as const;
export type Phase = (typeof PHASES)[number];

export const COUNTERS = ['blood', 'life', 'generic'] as const;
export type Counter = (typeof COUNTERS)[number];

export interface CardInstance {
  id: InstanceId;
  /** Missing in views where the card is hidden from the viewer. */
  cardId?: CardId;
  owner: SeatId;
  controller: SeatId;
  zone: ZoneId;
  locked: boolean;
  faceDown: boolean;
  contested: boolean;
  counters: Partial<Record<Counter, number>>;
  attachedTo?: InstanceId;
  /** Set by `JudgeReveal`; judges see the card until it is re-keyed. */
  judgeRevealed?: boolean;
}

export interface Occupancy {
  user: UserId;
  from: number;
  to?: number;
  reason: 'start' | 'replaced';
}

export interface Seat {
  /** Stable for the whole game. */
  id: SeatId;
  /** Current player; changes on replacement (GAME-19). */
  occupant: UserId;
  occupants: Occupancy[];
  pool: number;
  vp: number;
  hasEdge: boolean;
  ousted?: { atSeq: number; by?: SeatId };
  withdrawn?: boolean;
  /**
   * Phases whose end-of-phase pass round this seat passes automatically. Missing means every
   * phase (the default). Private: other viewers' views don't carry it.
   */
  autoPass?: Phase[];
}

export interface GameSettings {
  tournament: boolean;
  startingPool: number;
}

export interface Turn {
  number: number;
  seat: SeatId;
  phase: Phase;
}

export const ACTION_KINDS = [
  'bleed',
  'hunt',
  'political',
  'equip',
  'recruit',
  'employ',
  'other',
] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

/** A minion action in progress (GAME-06): declared → block window → combat or resolution. */
export interface ActionState {
  seat: SeatId;
  minion: InstanceId;
  kind: ActionKind;
  /** The seat the action is directed at; undirected actions have none. Bleeds always have one. */
  target?: SeatId;
  /** The action card played with it, still in the hand until the action ends. Public. */
  card?: InstanceId;
  cardId?: CardId;
  /** Seats that may block. */
  eligible: SeatId[];
  /** Eligible seats that passed with no block attempt pending; they can't block this action. */
  declined: SeatId[];
  blockAttempt?: { seat: SeatId; minion: InstanceId };
  stage: 'blocks' | 'combat' | 'resolution';
  blocker?: InstanceId;
}

/**
 * An ordered impulse window (architecture §4.4): the impulse moves through `order`; a card play
 * returns it to `order[0]` (the acting Methuselah) and voids the passes; the window closes when
 * every seat has passed in a row.
 */
export interface ImpulseWindow {
  kind: 'phase' | 'blocks';
  /** The phase this window belongs to (an end-of-phase round, or an action in the minion phase). */
  phase: Phase;
  order: SeatId[];
  /** Index into `order` of the seat holding the impulse. */
  cursor: number;
  /** Consecutive passes so far. */
  passes: number;
}

export interface GameState {
  id: GameId;
  engineVersion: string;
  format: Format;
  /** Last applied event. */
  seq: number;
  /** Physical seating, clockwise; never reordered (§4.1.1). */
  seats: Seat[];
  turnDirection: TurnDirection;
  cards: Record<InstanceId, CardInstance>;
  zones: Record<ZoneId, InstanceId[]>;
  turn?: Turn;
  action?: ActionState;
  window?: ImpulseWindow;
  settings: GameSettings;
  status: 'setup' | 'active' | 'finished';
}

/** Who a view is for (§4.5). The server sees everything. */
export type Viewer =
  | { kind: 'player'; seat: SeatId }
  | { kind: 'judge' }
  | { kind: 'spectator' }
  | { kind: 'server' };

/** Who issued a command. Players are mapped to their seat through the current occupant. */
export type Actor =
  | { kind: 'player'; user: UserId }
  | { kind: 'judge'; user: UserId }
  | { kind: 'admin'; user: UserId }
  | { kind: 'system' };

/** How an event records who caused it. */
export type ActorRef =
  | { kind: 'seat'; seat: SeatId }
  | { kind: 'judge'; user: UserId }
  | { kind: 'admin'; user: UserId }
  | { kind: 'system' };
