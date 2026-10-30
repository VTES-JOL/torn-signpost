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
