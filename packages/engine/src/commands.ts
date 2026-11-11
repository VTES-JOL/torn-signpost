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
  PassTarget,
  Phase,
  PLAYER_CALL_REASONS,
  Range,
  Ruling,
  StopRule,
  StrikeKind,
  UserId,
  VoteSide,
  VoteSource,
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

/** A claimed card effect; tournament games require the source. */
export interface OverrideClaim {
  source?: InstanceId;
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
  /** Replace your standing stops: situations in which you never pass automatically. */
  | { type: 'SetStops'; stops: StopRule[] }
  /**
   * Ask the open window to wait for you: you won't pass automatically until you pass by hand. If
   * your automatic pass already counted towards closing it, that pass is voided.
   */
  | { type: 'Hold' }
  /** Declare a minion action; `card` is an action card from the hand. */
  | {
      type: 'DeclareAction';
      minion: InstanceId;
      kind: ActionKind;
      target?: SeatId;
      card?: InstanceId;
      /**
       * Claim a card effect that lifts the default targeting rule (bleeding someone other than
       * your prey). `source` is the card that allows it: one of your face-up cards in play, or the
       * action card (the default). An action card the catalog tags needs no claim.
       */
      override?: OverrideClaim;
    }
  /** Pass the impulse. An eligible blocker's pass with no block attempt pending declines to block. */
  | { type: 'Pass' }
  /**
   * Attempt to block. A seat that isn't an eligible blocker claims a card effect with `override`:
   * `source` is a card from the hand, played with the attempt, or one of its face-up cards in play.
   */
  | { type: 'Block'; minion: InstanceId; override?: OverrideClaim }
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
  /**
   * The acting Methuselah resolves an unblocked action; bleeds and hunts apply their amount. An
   * action that enters combat starts it against `opponent`, a minion in play (M6.4). A successful
   * political action calls its referendum, on the `terms` its caller chooses now (M6.5).
   */
  | {
      type: 'ResolveAction';
      outcome: 'success' | 'failure' | 'combat';
      amount?: number;
      /** Take the Edge after a successful bleed. */
      edge?: boolean;
      opponent?: InstanceId;
      terms?: string;
    }
  /**
   * Cast votes in a referendum's polling step (docs/m6-plan.md M6.5, R5): a minion you control
   * (`minion`; its title's votes unless `votes` says otherwise), the Edge, the calling card's vote,
   * a political action card from your hand (`card`, burned), or `votes` from another source
   * (`card`: a card in your hand, played, or in play, named).
   */
  | {
      type: 'CastVotes';
      source: VoteSource;
      side: VoteSide;
      minion?: InstanceId;
      card?: InstanceId;
      votes?: number;
      /** A priscus's ballots, when not the 1 its title gives. */
      ballots?: number;
      note?: string;
    }
  /** Pass the rest of the referendum's polling step, casting nothing more. */
  | { type: 'Abstain' }
  /**
   * Make a minion abstain (Kateline Nadasdy, Demonstration): its votes and ballots, cast or to
   * come, don't count. `source`: the card it comes from, played from the hand or named in play.
   */
  | { type: 'CancelVotes'; minion: InstanceId; source?: InstanceId }
  /**
   * The acting Methuselah, or a judge, calls a blood hunt on a diablerist (by default the acting
   * vampire) while the action resolves (M6.5b).
   */
  | { type: 'CallBloodHunt'; minion?: InstanceId }
  /** Settle the referendum at once, for cards that do (Yoruba Shrine, Fakir al Sidi). */
  | { type: 'EndReferendum'; passed: boolean; note?: string }
  /**
   * Combat (docs/flow.md, "Combat"). Each names the card it comes from, if any: a card in the
   * hand is played with it; a card in play (a weapon, the minion itself) is only named.
   */
  | { type: 'Maneuver'; to: Range; source?: InstanceId }
  | {
      type: 'Strike';
      kind: StrikeKind;
      amount?: number;
      ranged?: boolean;
      aggravated?: boolean;
      first?: boolean;
      source?: InstanceId;
      note?: string;
    }
  /** In the damage step: prevent damage your combatant is about to take. */
  | { type: 'Prevent'; points: number; source?: InstanceId }
  /** In the damage step: an additional strike for your combatant, after this exchange. */
  | { type: 'AdditionalStrike'; source?: InstanceId }
  /** In the press step: press to continue the combat, or to end it. */
  | { type: 'Press'; mode: 'continue' | 'end'; source?: InstanceId }
  /** Pass every combat step up to `until`, unless the other combatant does something first. */
  | { type: 'PassUntil'; until: PassTarget }
  | { type: 'EndCombat' }
  /** Use an ability of a card in play: logged for the table, nothing else happens. */
  | { type: 'UseCard'; card: InstanceId; note?: string }
  | { type: 'CancelAction' }
  /** Admin only, non-tournament games only (GAME-19). */
  | { type: 'ReplacePlayer'; seat: SeatId; user: UserId }
  /**
   * The server records a seated player arriving at the table or leaving it (TEMPO-06). System
   * only: arrival is immediate, absence is debounced by the server.
   */
  | { type: 'SetPresence'; seat: SeatId; present: boolean }
  /** Pause a game with a table timer for a few minutes (at most 5): a player or a judge. */
  | { type: 'Pause'; minutes: number }
  /** Lift the pause early: whoever asked for it, or a judge. */
  | { type: 'Resume' }
  /** System: a deadline's reminder or expiry may be due (TEMPO-04). */
  | { type: 'CheckDeadline'; seat: SeatId }
  /** System: the time limit may have been reached (TEMPO-05). */
  | { type: 'CheckTimeLimit' }
  /** System: the pause may be over. */
  | { type: 'EndPause' }
  /** A seated player asks for a judge (GAME-18); at most one open call per player. */
  | {
      type: 'CallJudge';
      reason: (typeof PLAYER_CALL_REASONS)[number];
      seat?: SeatId;
      ref?: number;
      note?: string;
    }
  /** A judge takes a call. */
  | { type: 'ClaimJudgeCall'; id: string }
  /** A judge rules on a call (taking it first if nobody has). */
  | { type: 'ResolveJudgeCall'; id: string; ruling: Ruling; note?: string }
  /** An admin ends the game, scored as a timeout (docs/m6-plan.md, M6.1). */
  | { type: 'EndGame'; note?: string }
  /** Casual games: propose ending early; it ends once everyone still in it agrees (Q3). */
  /** Announce a withdrawal (GAME-09): your unlock phase, an empty library, a short hand. */
  | { type: 'Withdraw' }
  | { type: 'ProposeEnd' }
  | { type: 'AgreeEnd' }
  | { type: 'DeclineEnd' };

export type CommandType = Command['type'];

/** Commands only the server issues. */
export type SystemCommand = Extract<
  Command,
  { type: 'StartGame' | 'SetPresence' | 'CheckDeadline' | 'CheckTimeLimit' | 'EndPause' }
>;

/** Commands players, judges and admins send. */
export type ClientCommand = Exclude<Command, SystemCommand>;
