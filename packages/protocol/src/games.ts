/**
 * Game API and WebSocket messages (architecture §5.1, §5.2). Commands from clients are validated
 * here before they reach the engine.
 */
import { type Command, type GameEvent, type GameState, ZONE_NAMES } from '@torn-signpost/engine';
import { z } from 'zod';
import { DeckCards } from './decks.ts';

const Id = z.string().min(1).max(64);
const ZoneId = z.templateLiteral([z.string().min(1).max(64), ':', z.enum(ZONE_NAMES)]);
const opt = <T extends z.ZodType>(t: T) => t.exactOptional();
const Delta = z.number().int().min(-1000).max(1000);
const BloodHolder = z.union([z.strictObject({ pool: Id }), z.strictObject({ card: Id })]);

/** Every command a client may send. `StartGame` is issued by the server, never by clients. */
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
  z.strictObject({ type: z.literal('ReplacePlayer'), seat: Id, user: Id }),
]);
export type PlayerCommand = Exclude<Command, { type: 'StartGame' }>;

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
  players: { user: string; name: string }[];
  createdBy: string;
  createdAt: string;
  seq: number;
}

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
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

/** Server → client WebSocket messages. Clients detect `seq` gaps and catch up over HTTP. */
export type ServerMessage =
  | { type: 'subscribed'; gameId: string; seq: number }
  | { type: 'events'; gameId: string; events: GameEvent[] }
  | { type: 'lobby'; game: GameSummary }
  | { type: 'chat'; gameId: string; message: ChatMessage }
  | { type: 'pong' }
  | { type: 'error'; message: string };
