/**
 * Tournaments run through Archon, the VEKN's tournament manager (docs/m7-plan.md M7.2): an
 * organiser links an Archon tournament here; we keep a copy of its state for these pages, and
 * players register here (M7.3). Archon
 * counts rounds and tables from 0; these count from 1, as pages show them.
 */
import { z } from 'zod';
import type { DeckFormat } from './decks.ts';
import type { ArchonLink } from './users.ts';

/** Archon's tournament states, in order. */
export type TournamentState =
  | 'Planned'
  | 'Registration'
  | 'Waiting'
  | 'Playing'
  | 'Finals'
  | 'Finished';

/** What anyone can see of a linked tournament, in lists and at the top of its page. */
export interface TournamentSummary {
  /** The Archon tournament's uid. */
  id: string;
  name: string;
  state: TournamentState;
  format: string;
  online: boolean;
  start: string | null;
  finish: string | null;
  timezone: string | null;
  /** Where it's held, for in-person tournaments. */
  place: string | null;
  players: number;
  /** Its page in Archon. */
  archonUrl: string;
  /** The Torn Signpost player who linked it. */
  organiser: string;
}

export interface TournamentList {
  tournaments: TournamentSummary[];
}

export interface TournamentPlayer {
  archonUid: string;
  name: string;
  veknId: string | null;
  /** Archon's: Registered, Checked-in, Playing, Finished… */
  state: string;
  gw: number;
  vp: number;
  tp: number;
  missingDecklist: boolean;
  /** Their Torn Signpost name, if they've linked their Archon account here. */
  account: string | null;
  /** Registered here, with a deck locked for the tournament (M7.3). */
  registered: boolean;
}

export interface TournamentSeat {
  archonUid: string;
  name: string;
  vp: number;
  gw: number;
  tp: number;
}

export interface TournamentTable {
  /** From 1. */
  number: number;
  /** Archon's: In Progress, Finished, Invalid. */
  state: string;
  seats: TournamentSeat[];
}

export interface TournamentRound {
  /** From 1. */
  number: number;
  tables: TournamentTable[];
}

export interface TournamentStanding {
  rank: number;
  archonUid: string;
  name: string;
  gw: number;
  vp: number;
  tp: number;
  finalist: boolean;
  withdrawn: boolean;
  disqualified: boolean;
}

/** A tournament's page. Players, rounds and standings are for signed-in players only. */
export interface TournamentDetails extends TournamentSummary {
  description: string | null;
  /** Minutes. */
  roundTime: number;
  maxRounds: number;
  multideck: boolean;
  officials: string[];
  /** The winner's name, once finished. */
  winner: string | null;
  /** When we last read it from Archon. */
  updatedAt: string;
  detail?: {
    players: TournamentPlayer[];
    rounds: TournamentRound[];
    standings: TournamentStanding[];
  };
  /**
   * The deck format registering needs (ours, for picking a deck); null when registering here
   * doesn't support the tournament's format yet.
   */
  deckFormat: z.infer<typeof DeckFormat> | null;
  /** Whether players can register here now: Archon's Registration or Waiting (check-in). */
  registrationOpen: boolean;
  /** The signed-in player's own entry. */
  me?: TournamentEntry;
  /** For whoever may manage the link: its organiser and admins. */
  manage?: {
    /** `lost`: Archon refused the grant (revoked or expired): link it again. */
    grant: 'ok' | 'lost';
    /** The last read from Archon that failed, if the latest did. */
    lastError: string | null;
  };
}

/** A signed-in player's place in a tournament (M7.3). */
export interface TournamentEntry {
  /** Registering needs a linked Archon account… */
  archonLinked: boolean;
  /** …with a VEKN number: Archon refuses players without one. */
  veknId: string | null;
  /** Their state among Archon's players (Registered, Checked-in, Playing…), if they're there. */
  archonState: string | null;
  registration: {
    deckId: string;
    deckName: string;
    deckVersion: number;
    registeredAt: string;
    /** They dropped out after registration closed. */
    dropped: boolean;
  } | null;
}

/** Register (or change the deck registered): the player's own deck, its latest version. */
export const RegisterRequest = z.strictObject({
  deckId: z.string().min(1).max(100),
});
export type RegisterRequest = z.infer<typeof RegisterRequest>;

/** Link an Archon tournament: its address in Archon, or its uid. */
export const LinkTournamentRequest = z.strictObject({
  archon: z.string().trim().min(1).max(300),
});
export type LinkTournamentRequest = z.infer<typeof LinkTournamentRequest>;

/** What finishing a sign-in at /archon/callback did. */
export type ArchonCallbackResult =
  | { purpose: 'profile'; link: ArchonLink }
  | { purpose: 'tournament'; tournamentId: string };
