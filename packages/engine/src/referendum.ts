/**
 * Counting a referendum (rulebook, "Politics"; docs/m6-plan.md M6.5): the votes on each side, and
 * the prisci block's 3 votes to whichever side has more priscus ballots (a tie: to neither;
 * zero-vtes rules-qa 52.9). Shared by the engine, the scenarios and the clients.
 */
import type { ReferendumState, VoteSide } from './model.ts';

export const PRISCI_BLOCK = 3;

export interface Tally {
  for: number;
  against: number;
  /** The prisci sub-referendum, when any ballot was cast. */
  prisci?: { for: number; against: number; side?: VoteSide };
}

export function tally(r: ReferendumState): Tally {
  const sum = (side: VoteSide, key: 'votes' | 'ballots') =>
    r.votes.filter((v) => v.side === side).reduce((n, v) => n + (v[key] ?? 0), 0);
  const out: Tally = { for: sum('for', 'votes'), against: sum('against', 'votes') };
  const ballots = { for: sum('for', 'ballots'), against: sum('against', 'ballots') };
  if (ballots.for || ballots.against) {
    const side =
      ballots.for > ballots.against ? 'for' : ballots.against > ballots.for ? 'against' : undefined;
    out.prisci = side ? { ...ballots, side } : ballots;
    if (side) out[side] += PRISCI_BLOCK;
  }
  return out;
}
