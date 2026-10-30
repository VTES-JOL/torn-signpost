/**
 * Display names (AUTH-05). Every request's identity carries the user's chosen name, so games,
 * chat and decks record it without looking it up themselves. Names already recorded in games and
 * decks keep the name used at the time.
 */
import type { Profile, UpdateProfileRequest } from '@torn-signpost/protocol';
import type { Identity } from '../auth.ts';
import type { ProfileStore } from '../db/profiles.ts';
import { ApiError } from '../errors.ts';

const RESERVED = new Set([
  'admin',
  'administrator',
  'anonymous',
  'guest',
  'judge',
  'me',
  'moderator',
  'player',
  'support',
  'system',
  'torn-signpost',
  'tornsignpost',
]);

/** How long a warm Lambda trusts a cached name; renames elsewhere show up after this. */
const CACHE_MS = 60_000;
const CACHE_MAX = 10_000;

export interface ProfileServiceDeps {
  store: ProfileStore;
  now?: () => Date;
}

type User = Extract<Identity, { kind: 'user' }>;

export class ProfileService {
  private readonly now: () => Date;
  private readonly cache = new Map<string, { name: string | undefined; at: number }>();

  constructor(private readonly deps: ProfileServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** The identity with its chosen name, if the user has one. */
  async resolve(identity: Identity): Promise<Identity> {
    if (identity.kind !== 'user') return identity;
    const name = await this.chosenName(identity.sub);
    return name ? { ...identity, name } : identity;
  }

  async me(identity: Identity): Promise<Profile> {
    const user = requireUser(identity);
    const name = await this.chosenName(user.sub);
    return {
      sub: user.sub,
      name: name ?? user.name,
      chosen: name !== undefined,
      groups: user.groups,
    };
  }

  async rename(identity: Identity, req: UpdateProfileRequest): Promise<Profile> {
    const user = requireUser(identity);
    if (RESERVED.has(req.name.toLowerCase())) {
      throw new ApiError(409, 'name_taken', `“${req.name}” is reserved`);
    }
    const current = await this.deps.store.get(user.sub);
    if (current?.name !== req.name) {
      const result = await this.deps.store.rename(
        user.sub,
        req.name,
        current?.name,
        this.now().toISOString(),
      );
      if (result === 'taken') throw new ApiError(409, 'name_taken', `“${req.name}” is taken`);
      if (result === 'stale') throw new ApiError(409, 'stale', 'Your name just changed; try again');
    }
    this.remember(user.sub, req.name);
    return { sub: user.sub, name: req.name, chosen: true, groups: user.groups };
  }

  private async chosenName(sub: string): Promise<string | undefined> {
    const hit = this.cache.get(sub);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.name;
    const name = (await this.deps.store.get(sub))?.name;
    this.remember(sub, name);
    return name;
  }

  private remember(sub: string, name: string | undefined) {
    if (this.cache.size >= CACHE_MAX) this.cache.clear();
    this.cache.set(sub, { name, at: Date.now() });
  }
}

function requireUser(identity: Identity): User {
  if (identity.kind !== 'user') throw new ApiError(401, 'sign_in', 'Sign in first');
  return identity;
}
