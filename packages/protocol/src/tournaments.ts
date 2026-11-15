/**
 * Tournaments run through Archon, the VEKN's tournament manager (docs/m7-plan.md M7.2): an
 * organiser links an Archon tournament here; we keep a copy of its state for these pages. Archon
 * counts rounds and tables from 0; these count from 1, as pages show them.
 */
import { z } from 'zod';
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
  /** For whoever may manage the link: its organiser and admins. */
  manage?: {
    /** `lost`: Archon refused the grant (revoked or expired): link it again. */
    grant: 'ok' | 'lost';
    /** The last read from Archon that failed, if the latest did. */
    lastError: string | null;
  };
}

/** Link an Archon tournament: its address in Archon, or its uid. */
export const LinkTournamentRequest = z.strictObject({
  archon: z.string().trim().min(1).max(300),
});
export type LinkTournamentRequest = z.infer<typeof LinkTournamentRequest>;

/** What finishing a sign-in at /archon/callback did. */
export type ArchonCallbackResult =
  | { purpose: 'profile'; link: ArchonLink }
  | { purpose: 'tournament'; tournamentId: string };
