/** Profiles (AUTH-05, LOBBY-04). Display names are unique, ignoring case, and can be changed. */
import { z } from 'zod';

/**
 * Letters, digits, `_` and `-`, so a name works as an `@mention` and in the console. No spaces,
 * which also keeps chosen names apart from the "Player 1a2b" placeholder.
 */
export const DisplayName = z
  .string()
  .trim()
  .min(3, 'At least 3 characters')
  .max(24, 'At most 24 characters')
  .regex(/^[A-Za-z0-9_-]+$/, 'Letters, digits, _ and - only');

export const UpdateProfileRequest = z.strictObject({ name: DisplayName });
export type UpdateProfileRequest = z.infer<typeof UpdateProfileRequest>;

export interface Profile {
  sub: string;
  name: string;
  /** False until the user picks a name; until then `name` is a placeholder. */
  chosen: boolean;
  groups: string[];
}

/** A player's link to their Archon account (docs/m7-plan.md M7.1): tournaments need it. */
export interface ArchonLink {
  linked: boolean;
  /** Their Archon member uid. */
  archonUid?: string;
  /** Archon refuses tournament players without one; a Prince issues it. */
  veknId?: string | null;
  linkedAt?: string;
}

/** Where to send the player to approve the link in Archon. */
export interface ArchonLinkStart {
  url: string;
}

/** What Archon sent back to /archon/callback. */
export const ArchonCallbackRequest = z.strictObject({
  state: z.string().min(1).max(200),
  code: z.string().min(1).max(2000).optional(),
  error: z.string().max(200).optional(),
});
export type ArchonCallbackRequest = z.infer<typeof ArchonCallbackRequest>;
