/**
 * Core game model (architecture §4.1). The game is modelled around seats: cards, zones, pool and
 * VP belong to a seat, and a user occupies a seat. The same `GameState` shape serves as the full
 * server state and as a redacted per-viewer view (`cardId` is missing on cards the viewer can't
 * see), so `evolve` runs unchanged on both.
 */
import type { Grant } from './catalog.ts';
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
  /** Out of the game by a judge's ruling (tournaments): not an oust, nobody gains VP or pool. */
  disqualified?: true;
  withdrawn?: boolean;
  /**
   * Whether the seat's player has the game open (TEMPO-06). Missing means away: every seat starts
   * away until the server sees its player at the table.
   */
  present?: true;
  /** When the seat's player was last seen leaving (or the game started without them). */
  awaySince?: Instant;
  /** How much of their pause allowance the seat's player has used (`MAX_PAUSE_TOTAL_MINUTES`). */
  pausedMs?: number;
  /**
   * Phases whose end-of-phase pass round this seat passes automatically. Missing means every
   * phase (the default). Private: other viewers' views don't carry it.
   */
  autoPass?: Phase[];
  /**
   * Standing stops: situations in which this seat never passes automatically, whatever its
   * auto-pass setting. Missing means none. Private, like `autoPass`.
   */
  stops?: StopRule[];
}

/**
 * When a seat wants the impulse to wait for it instead of passing automatically. A stop fires
 * whatever is in the hand, so it gives nothing away. Rules are matched by `stopApplies` in
 * `flow.ts`, the one place a new trigger needs code.
 *
 * Kept open for player-defined stops: new triggers are new `on` variants, e.g. a card being played
 * (`{ on: 'card-played'; cards?: CardId[]; types?: string[]; by?: StopActors }`) or an action kind
 * (`{ on: 'action'; kinds: ActionKind[]; actors: StopActors }`).
 */
export type StopRule = { on: 'block-window'; actors: StopActors };

/** Whose actions a stop covers: those of your prey and predator, or anyone's. */
export type StopActors = 'neighbours' | 'anyone';

export const STOP_TRIGGERS = ['block-window'] as const satisfies readonly StopRule['on'][];
export const STOP_ACTORS = ['neighbours', 'anyone'] as const satisfies readonly StopActors[];

export interface GameSettings {
  tournament: boolean;
  startingPool: number;
  /**
   * The table timer (TEMPO-05): how long the game may take, counting only while it's live. None
   * for a casual game without one; tournament games always have one (at least 2 h).
   */
  timeLimitMs?: number;
  /** How long a player who is away has for each decision (TEMPO-04); 24 h when missing. */
  deadlineMs?: number;
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
  /** Set when the action breaks the default targeting rule (a bleed on someone else's prey…). */
  override?: Override;
  blockAttempt?: { seat: SeatId; minion: InstanceId; override?: Override };
  stage: 'blocks' | 'combat' | 'resolution';
  blocker?: InstanceId;
}

export const JUDGE_CALL_REASONS = [
  'slow-play',
  'rules',
  'dispute',
  'deadline',
  'time-limit',
  'other',
] as const;
/** Why a judge was called. `deadline` and `time-limit` calls are opened by the game itself. */
export type JudgeCallReason = (typeof JUDGE_CALL_REASONS)[number];
/** The reasons a player can call a judge for. */
export const PLAYER_CALL_REASONS = ['slow-play', 'rules', 'dispute', 'other'] as const;

export interface JudgeCall {
  /** `c<seq>`: the event that opened it. */
  id: string;
  reason: JudgeCallReason;
  /** The seat that called; missing when the game opened the call. */
  by?: SeatId;
  /** The seat the call is about, if any. */
  seat?: SeatId;
  /** The event it is about (an unverified override for a dispute). */
  ref?: number;
  note?: string;
  openedAt: Instant;
  /** The judge handling it, so two judges don't answer the same call. */
  claimedBy?: UserId;
}

/** What a judge decided (GAME-18). Every ruling is logged, by the judge. */
/** Why a game ended (GAME-08/09). */
export type GameEndReason =
  /** One Methuselah left in the game: they gain a VP for it. */
  | 'last-standing'
  /** Everyone left was ousted at once (zero-vtes rules-qa 6.9). */
  | 'no-survivors'
  /** The time limit: half a VP to each Methuselah still in the game. */
  | 'time-limit'
  /** An admin ended it, scored as a timeout. */
  | 'admin'
  /** The players of a casual game agreed to end it, scored as a timeout. */
  | 'agreement';

export interface GameResult {
  reason: GameEndReason;
  /** The most VP, alone; ties have no winner (rulebook), ousted or not. */
  winner?: SeatId;
  /** A game win: the winner with at least 2 VP (VEKN Tournament Rules). */
  gameWin?: SeatId;
  at: Instant;
}

export type Ruling =
  /** Answered at the table (a rules question, a dispute settled with the usual tools). */
  | { kind: 'answered' }
  /** More time for an away player's decision. */
  | { kind: 'extend-deadline'; seat: SeatId; hours: number }
  /** Pass for a player who holds the impulse: the default for an expired decision. */
  | { kind: 'pass-for'; seat: SeatId }
  /** Time added to the table timer for a judge-caused delay (Conduct Guide 1.2.4). */
  | { kind: 'extend-time'; minutes: number }
  /** Tournament games: the player is out (Conduct Guide 1.1.4, 4.11). Not an oust. */
  | { kind: 'disqualify'; seat: SeatId }
  /** Casual games: referred to a server admin, who can replace the player (GAME-19). */
  | { kind: 'escalate' };

export const RULING_KINDS = [
  'answered',
  'extend-deadline',
  'pass-for',
  'extend-time',
  'disqualify',
  'escalate',
] as const satisfies readonly Ruling['kind'][];

/**
 * A default flow rule set aside by a card effect the player claims (docs/flow.md, "Overrides").
 * Public: the source is a card in play, the action card, or a card played with the command.
 */
export interface Override {
  grant: Grant;
  /** The card that allows it; missing for a claim without one (casual games only). */
  source?: InstanceId;
  sourceCardId?: CardId;
  /** The catalog confirms the source lifts this rule. Unverified overrides are flagged. */
  verified: boolean;
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
  /**
   * Seats that asked to hold this window (`Hold`): none of them passes automatically until it
   * passes by hand. Public, like asking the table to wait. Cleared when the window closes.
   */
  holds?: SeatId[];
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
  /**
   * The current wait (`waitingOn`): its key, and the event that started it, kept by `evolve`; and
   * the seats in it already reminded of their deadline, or past it (`clock.ts`).
   */
  waiting?: {
    key: string;
    seq: number;
    at: Instant;
    reminded?: SeatId[];
    expired?: SeatId[];
    /** Extra time a judge gave a seat for this decision. */
    extendedMs?: Record<SeatId, number>;
  };
  /**
   * The table clock: time played while live, and since when it has been running; `extendedMs` is
   * time judges added (Conduct Guide 1.2.4).
   */
  clock?: {
    elapsedMs: number;
    runningSince?: Instant;
    limitReachedAt?: Instant;
    /**
     * Once time is up, the game ends with the action that was under way then, or at the end of the
     * phase if none was (Tournament Rules 3.1.1, docs/m6-plan.md Q2).
     */
    endsWith?: 'action' | 'phase';
    extendedMs?: number;
  };
  /** Judge calls waiting for a judge's ruling (GAME-18); resolved calls are only in the log. */
  judgeCalls?: JudgeCall[];
  /** A casual game's players agreeing to end it early (docs/m6-plan.md Q3). */
  endProposal?: { by: SeatId; agreed: SeatId[] };
  /** How a finished game ended (GAME-09). */
  result?: GameResult;
  /** A pause (TEMPO-05): nothing happens at the table until it ends or is lifted. */
  pause?: { seat?: SeatId; since: Instant; until: Instant };
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
