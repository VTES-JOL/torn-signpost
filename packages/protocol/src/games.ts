/**
 * Game API and WebSocket messages (architecture §5.1, §5.2). Commands from clients are validated
 * here before they reach the engine.
 */
import {
  ACTION_KINDS,
  type ClientCommand,
  type GameEvent,
  type GameState,
  type JudgeCall,
  PHASES,
  PLAYER_CALL_REASONS,
  STOP_ACTORS,
  ZONE_NAMES,
} from '@torn-signpost/engine';
import { z } from 'zod';
import { DeckCards } from './decks.ts';
import type { Notification } from './notifications.ts';

const Id = z.string().min(1).max(64);
const ZoneId = z.templateLiteral([z.string().min(1).max(64), ':', z.enum(ZONE_NAMES)]);
const opt = <T extends z.ZodType>(t: T) => t.exactOptional();
const Delta = z.number().int().min(-1000).max(1000);
const OverrideClaim = z.strictObject({ source: opt(Id) });
const BloodHolder = z.union([z.strictObject({ pool: Id }), z.strictObject({ card: Id })]);
const Note = z.string().max(500);
const Ruling = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('answered') }),
  z.strictObject({ kind: z.literal('escalate') }),
  z.strictObject({
    kind: z.literal('extend-deadline'),
    seat: Id,
    hours: z.number().int().min(1).max(168),
  }),
  z.strictObject({ kind: z.literal('pass-for'), seat: Id }),
  z.strictObject({ kind: z.literal('extend-time'), minutes: z.number().int().min(1).max(120) }),
  z.strictObject({ kind: z.literal('disqualify'), seat: Id }),
]);

/** Every command a client may send. System commands are issued by the server, never by clients. */
export const PlayerCommand = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('MoveCard'),
    card: Id,
    to: ZoneId,
    position: opt(z.enum(['top', 'bottom'])),
    faceDown: opt(z.boolean()),
  }),
  z.strictObject({
    type: z.literal('Draw'),
    seat: opt(Id),
    from: opt(z.enum(['library', 'crypt'])),
    count: opt(z.number().int().min(1).max(100)),
  }),
  z.strictObject({ type: z.literal('Shuffle'), zone: ZoneId }),
  z.strictObject({ type: z.literal('Flip'), card: Id }),
  z.strictObject({ type: z.literal('SetLocked'), card: Id, locked: z.boolean() }),
  z.strictObject({ type: z.literal('SetContested'), card: Id, contested: z.boolean() }),
  z.strictObject({
    type: z.literal('AdjustCounter'),
    card: Id,
    counter: z.enum(['blood', 'life', 'generic']),
    delta: Delta,
  }),
  z.strictObject({ type: z.literal('AdjustPool'), seat: Id, delta: Delta }),
  z.strictObject({ type: z.literal('AdjustVp'), seat: Id, delta: z.number().min(-10).max(10) }),
  z.strictObject({
    type: z.literal('TransferBlood'),
    from: BloodHolder,
    to: BloodHolder,
    amount: z.number().int().min(1).max(1000),
  }),
  z.strictObject({ type: z.literal('Attach'), card: Id, to: opt(Id) }),
  z.strictObject({ type: z.literal('Reveal'), card: Id }),
  z.strictObject({ type: z.literal('JudgeReveal'), card: Id }),
  z.strictObject({ type: z.literal('SetEdge'), seat: opt(Id) }),
  z.strictObject({
    type: z.literal('SetTurnDirection'),
    direction: z.enum(['toPrey', 'toPredator']),
  }),
  z.strictObject({ type: z.literal('AdvancePhase') }),
  z.strictObject({ type: z.literal('SetAutoPass'), phases: z.array(z.enum(PHASES)).max(5) }),
  z.strictObject({
    type: z.literal('SetStops'),
    stops: z
      .array(
        z.discriminatedUnion('on', [
          z.strictObject({ on: z.literal('block-window'), actors: z.enum(STOP_ACTORS) }),
        ]),
      )
      .max(20),
  }),
  z.strictObject({ type: z.literal('Hold') }),
  z.strictObject({
    type: z.literal('DeclareAction'),
    minion: Id,
    kind: z.enum(ACTION_KINDS),
    target: opt(Id),
    card: opt(Id),
    override: opt(OverrideClaim),
  }),
  z.strictObject({ type: z.literal('Pass') }),
  z.strictObject({ type: z.literal('Block'), minion: Id, override: opt(OverrideClaim) }),
  z.strictObject({ type: z.literal('WithdrawBlock') }),
  z.strictObject({
    type: z.literal('PlayCard'),
    card: Id,
    to: opt(z.enum(['ashHeap', 'ready'])),
    attachTo: opt(Id),
    replace: opt(z.boolean()),
  }),
  z.strictObject({
    type: z.literal('ResolveAction'),
    outcome: z.enum(['success', 'failure']),
    amount: opt(z.number().int().min(0).max(30)),
    edge: opt(z.boolean()),
  }),
  z.strictObject({ type: z.literal('EndCombat') }),
  z.strictObject({ type: z.literal('CancelAction') }),
  z.strictObject({ type: z.literal('ReplacePlayer'), seat: Id, user: Id }),
  z.strictObject({ type: z.literal('Pause'), minutes: z.number().int().min(1).max(5) }),
  z.strictObject({ type: z.literal('Resume') }),
  z.strictObject({
    type: z.literal('CallJudge'),
    reason: z.enum(PLAYER_CALL_REASONS),
    seat: opt(Id),
    ref: opt(z.number().int().min(1)),
    note: opt(Note),
  }),
  z.strictObject({ type: z.literal('ClaimJudgeCall'), id: Id }),
  z.strictObject({
    type: z.literal('ResolveJudgeCall'),
    id: Id,
    ruling: Ruling,
    note: opt(Note),
  }),
]);
export type PlayerCommand = ClientCommand;

// Compile-time check that the schema and the engine agree, in both directions.
type Parsed = z.infer<typeof PlayerCommand>;
type Assert<T extends true> = T;
export type _SchemaMatchesEngine = [
  Assert<Parsed extends PlayerCommand ? true : false>,
  Assert<PlayerCommand extends Parsed ? true : false>,
];

export const Format = z.enum(['standard', 'v5', 'duel']);
export const Visibility = z.enum(['public', 'private']);
export const LobbyStatus = z.enum(['open', 'active', 'finished']);
export type LobbyStatus = z.infer<typeof LobbyStatus>;

export const CreateGameRequest = z.strictObject({
  name: z.string().trim().min(1).max(60),
  format: Format,
  visibility: Visibility,
  maxSeats: z.number().int().min(2).max(5),
  /** The table timer (TEMPO-05); none for an untimed casual game. */
  timeLimitMinutes: opt(z.number().int().min(10).max(600)),
  /** How long a player who is away has for each decision (TEMPO-04); 24 h by default. */
  deadlineHours: opt(z.number().int().min(1).max(168)),
});
export type CreateGameRequest = z.infer<typeof CreateGameRequest>;

/** Join with a saved deck (optionally a specific version), or an inline list. */
export const JoinGameRequest = z.union([
  z.strictObject({ deckId: z.string().min(1).max(64), version: opt(z.number().int().min(1)) }),
  z.strictObject({ deck: DeckCards }),
]);
export type JoinGameRequest = z.infer<typeof JoinGameRequest>;

export const CommandRequest = z.strictObject({
  /** Client-generated; retries with the same ID are applied once (architecture §5.2). */
  commandId: z.string().regex(/^[\w-]{8,64}$/),
  /** Reject instead of retrying if the game has moved on since the client last saw it. */
  expectedSeq: opt(z.number().int().min(0)),
  command: PlayerCommand,
});
export type CommandRequest = z.infer<typeof CommandRequest>;

export interface GameSummary {
  id: string;
  name: string;
  format: z.infer<typeof Format>;
  visibility: z.infer<typeof Visibility>;
  status: LobbyStatus;
  maxSeats: number;
  timeLimitMinutes?: number;
  deadlineHours?: number;
  players: { user: string; name: string }[];
  createdBy: string;
  createdAt: string;
  seq: number;
}

/** An open judge call in the judge queue (GAME-18), across all games. */
export interface JudgeQueueEntry {
  gameId: string;
  gameName: string;
  tournament: boolean;
  call: JudgeCall;
}

/**
 * A casual game a judge referred to the admins (GAME-19): usually a player who has gone, to be
 * replaced. It stays in the admin queue until an admin replaces the player or dismisses it.
 */
export interface Escalation {
  gameId: string;
  gameName: string;
  call: JudgeCall;
  /** The judge who referred it, and what they said. */
  judge: string;
  note?: string;
  at: string;
}

/** An admin deals with an escalation: replace a seat's player (by display name), or dismiss it. */
export const ResolveEscalationRequest = z.union([
  z.strictObject({ replace: z.strictObject({ seat: Id, name: z.string().trim().min(1).max(24) }) }),
  z.strictObject({ dismiss: z.literal(true) }),
]);
export type ResolveEscalationRequest = z.infer<typeof ResolveEscalationRequest>;

export interface GameDetails {
  game: GameSummary;
  /** The caller's projected view; absent before the game starts. */
  view?: GameState;
  /** The caller's seat, if they occupy one. */
  seat?: string;
}

export interface CommandResponse {
  seq: number;
  /** The command's events, projected for the caller. */
  events: GameEvent[];
}

export interface EventsResponse {
  seq: number;
  events: GameEvent[];
  /** More events follow; ask again with `after` = last returned seq. */
  more: boolean;
}

export interface ApiError {
  error: string;
  message: string;
}

export const ChatRequest = z.strictObject({ text: z.string().trim().min(1).max(500) });
export type ChatRequest = z.infer<typeof ChatRequest>;

/** In-game chat (GAME-12, LOBBY-03), shown interleaved with the log by `seq`. */
export interface ChatMessage {
  id: string;
  user: string;
  name: string;
  text: string;
  at: string;
  /** The game's seq when the message was sent. */
  seq: number;
}

/** Client → server WebSocket messages. */
export const ClientMessage = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('subscribe'), gameId: Id }),
  z.strictObject({ type: z.literal('unsubscribe'), gameId: Id }),
  z.strictObject({ type: z.literal('ping') }),
  /** The user is using the site (input, or the tab coming back into view); a ping isn't. */
  z.strictObject({ type: z.literal('active') }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

/** Server → client WebSocket messages. Clients detect `seq` gaps and catch up over HTTP. */
export type ServerMessage =
  | { type: 'subscribed'; gameId: string; seq: number }
  | { type: 'events'; gameId: string; events: GameEvent[] }
  | { type: 'lobby'; game: GameSummary }
  | { type: 'chat'; gameId: string; message: ChatMessage }
  /** Who else is watching (TEMPO-06): signed-in users who aren't seated. Seated presence is in the game. */
  | { type: 'audience'; gameId: string; spectators: number }
  /** A new notification for this user (NOTIF-01), on every connection they have. */
  | { type: 'notification'; notification: Notification }
  /** Notifications marked read elsewhere (the game was opened, or the wait is over). */
  | { type: 'notifications-read'; ids: string[]; unread: number }
  | { type: 'pong' }
  | { type: 'error'; message: string };
