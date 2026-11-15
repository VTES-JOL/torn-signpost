/**
 * The parts of Archon's API that Torn Signpost uses (docs/m7-plan.md, "Spike findings"). Archon's
 * own API reference isn't public: these shapes come from its test server, archon.krcg.org, and its
 * web app's source, and are checked by `contract.test.ts`. Unknown fields are kept, not read.
 */

/** Tournament states, in order (Planned → … → Finished). */
export type TournamentState =
  | 'Planned'
  | 'Registration'
  | 'Waiting'
  | 'Playing'
  | 'Finals'
  | 'Finished';

export interface Result {
  gw: number;
  vp: number;
  tp: number;
}

export interface Player {
  /** The player's Archon member uid. */
  user_uid: string;
  state: string;
  result: Result;
  display_name?: string | null;
  missing_decklist?: boolean;
  finalist?: boolean;
  toss?: number;
}

export interface Seat {
  player_uid: string;
  result?: Result;
}

/** `In Progress` until its scores add up; `Invalid` when they can't; `Finished` once they do. */
export interface Table {
  seating: Seat[];
  state: string;
}

export interface Standing extends Result {
  user_uid: string;
  toss: number;
  finalist: boolean;
  withdrawn: boolean;
  disqualified: boolean;
}

export interface Tournament {
  uid: string;
  name: string;
  state: TournamentState;
  format: string;
  online: boolean;
  start: string | null;
  finish: string | null;
  /** Seconds. */
  round_time: number;
  max_rounds: number;
  multideck: boolean;
  players: Player[];
  /** One entry per round, each a list of tables. */
  rounds: Table[][];
  standings: Standing[];
  finals: unknown;
  modified: string;
  [key: string]: unknown;
}

/** An Archon member, as much of them as we keep: never their contact details. */
export interface Member {
  uid: string;
  name: string;
  vekn_id: string | null;
}

/** What `/oauth/userinfo` says about the member who granted `profile:read`. */
export interface UserInfo {
  sub: string;
  vekn_id: string | null;
  roles: string[];
}

export interface Tokens {
  access_token: string;
  /** Archon rotates it: every refresh returns a new one, and the old one stops working. */
  refresh_token?: string;
  expires_in: number;
  scope: string;
}

export interface Score {
  player_uid: string;
  vp: number;
}

/**
 * The actions we send. Rounds and tables count from 0 here (pages show them from 1).
 * `StartRound` without a seating has Archon draw the tables.
 */
export type Action =
  | { type: 'OpenRegistration' }
  | { type: 'CloseRegistration' }
  | { type: 'AddPlayer'; user_uid: string }
  | { type: 'Register'; user_uid: string }
  | { type: 'Unregister'; player_uid: string }
  | { type: 'DropOut'; player_uid: string }
  | { type: 'CheckIn'; player_uid: string }
  | { type: 'CheckInAll' }
  | {
      type: 'UpsertDeck';
      player_uid: string;
      deck: { name: string; comments: string; cards: Record<string, number>; round?: number };
    }
  | { type: 'StartRound'; seating?: string[][] }
  | { type: 'SetScore'; round: number; table: number; scores: Score[] }
  | { type: 'FinishRound' }
  | { type: 'StartFinals' }
  | { type: 'FinishFinals' };
