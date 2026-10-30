/**
 * Display names (AUTH-05). Every request's identity carries the user's chosen name, so games,
 * chat and decks record it without looking it up themselves. Names already recorded in games and
 * decks keep the name used at the time.
 *
 * To prevent impersonation, players choose a name once; after that only admins can rename them,
 * and no name is ever given to a second user.
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

  /** Choose a display name; only possible while the user has none. */
  async choose(identity: Identity, req: UpdateProfileRequest): Promise<Profile> {
    const user = requireUser(identity);
    const current = await this.deps.store.get(user.sub);
    if (current && current.name !== req.name) {
      throw new ApiError(
        409,
        'name_locked',
        'Display names are permanent; ask an admin to change it',
      );
    }
    if (!current) await this.claim(user.sub, req.name, undefined);
    return { sub: user.sub, name: req.name, chosen: true, groups: user.groups };
  }

  /** Admins only: rename the user who holds `name`. */
  async adminRename(identity: Identity, name: string, req: UpdateProfileRequest): Promise<void> {
    const admin = requireUser(identity);
    if (!admin.groups.includes('admin')) throw new ApiError(403, 'admin_only', 'Admins only');
    const sub = await this.deps.store.ownerOf(name);
    const current = sub ? await this.deps.store.get(sub) : undefined;
    if (!sub || current?.name.toLowerCase() !== name.toLowerCase()) {
      throw new ApiError(404, 'not_found', `Nobody is called “${name}”`);
    }
    if (current.name !== req.name) await this.claim(sub, req.name, current.name);
  }

  private async claim(sub: string, name: string, previous: string | undefined) {
    if (RESERVED.has(name.toLowerCase())) {
      throw new ApiError(409, 'name_taken', `“${name}” is reserved`);
    }
    const result = await this.deps.store.rename(sub, name, previous, this.now().toISOString());
    if (result === 'taken') throw new ApiError(409, 'name_taken', `“${name}” is taken`);
    if (result === 'stale') throw new ApiError(409, 'stale', 'The name just changed; try again');
    this.remember(sub, name);
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
