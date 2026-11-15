/**
 * Signing in with Archon (docs/m7-plan.md M7.1, M7.2). A player starts it here; we send them to
 * Archon's consent page with a PKCE challenge; Archon sends them back to the web app's
 * /archon/callback, which posts the code here; we exchange it with the client secret. Then:
 *
 * - `profile:read`, linking their own account: we ask Archon who they are and keep their Archon
 *   uid and VEKN number, not the tokens;
 * - `event:run` for a tournament they run: the tokens go to the tournaments service, which keeps
 *   them (sealed) to act on that tournament.
 */

import { randomBytes } from 'node:crypto';
import {
  type ArchonConfig,
  ArchonError,
  consentUrl,
  exchangeCode,
  pkce,
  type Tokens,
  userInfo,
} from '@torn-signpost/archon';
import type {
  ArchonCallbackRequest,
  ArchonCallbackResult,
  ArchonLink,
  ArchonLinkStart,
} from '@torn-signpost/protocol';
import type { Identity } from '../auth.ts';
import type { ArchonStore } from '../db/archon.ts';
import { ApiError } from '../errors.ts';

/** How long a player has to approve in Archon. */
const SIGN_IN_SECONDS = 15 * 60;

export interface ArchonServiceDeps {
  store: ArchonStore;
  /** Read lazily: the client secret comes from Secrets Manager. */
  config: () => Promise<ArchonConfig>;
  now?: () => Date;
  /** Takes an `event:run` grant for a tournament; returns the tournament's id here. */
  tournamentGranted?: (sub: string, tournament: string, tokens: Tokens) => Promise<string>;
}

export class ArchonService {
  private readonly now: () => Date;

  constructor(private readonly deps: ArchonServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async status(identity: Identity): Promise<ArchonLink> {
    const user = requireUser(identity);
    const link = await this.deps.store.getLink(user.sub);
    return link ? { linked: true, ...link } : { linked: false };
  }

  /** Where to send the player to approve the link. */
  async start(identity: Identity): Promise<ArchonLinkStart> {
    return { url: await this.begin(requireUser(identity).sub, 'profile') };
  }

  /** Where to send `sub` to approve: their own profile, or running `tournament` for us. */
  async begin(
    sub: string,
    purpose: 'profile' | 'tournament',
    tournament?: string,
  ): Promise<string> {
    const config = await this.deps.config();
    const { verifier, challenge } = pkce();
    const state = randomBytes(24).toString('base64url');
    await this.deps.store.putPending(state, {
      sub,
      verifier,
      purpose,
      ...(tournament ? { tournament } : {}),
      expires: Math.floor(this.now().getTime() / 1000) + SIGN_IN_SECONDS,
    });
    return purpose === 'profile'
      ? consentUrl(config, { scope: 'profile:read', state, challenge })
      : consentUrl(config, {
          scope: 'event:run',
          state,
          challenge,
          ...(tournament ? { tournament } : {}),
        });
  }

  /** Archon sent the player back: finish what they started. */
  async complete(identity: Identity, req: ArchonCallbackRequest): Promise<ArchonCallbackResult> {
    const user = requireUser(identity);
    const pending = await this.deps.store.takePending(req.state);
    // Someone else's sign-in, or a replayed or stale one: refuse all alike.
    if (!pending || pending.sub !== user.sub || pending.expires * 1000 < this.now().getTime()) {
      throw new ApiError(400, 'archon_link_expired', 'That link request has expired: start again');
    }
    if (req.error || !req.code) {
      throw new ApiError(400, 'archon_declined', 'Archon didn’t approve the link');
    }
    const config = await this.deps.config();
    const tokens = await archon(() => exchangeCode(config, req.code ?? '', pending.verifier));
    if (pending.purpose === 'tournament') {
      if (!pending.tournament || !this.deps.tournamentGranted) {
        throw new ApiError(
          400,
          'archon_link_expired',
          'That link request has expired: start again',
        );
      }
      const tournamentId = await this.deps.tournamentGranted(user.sub, pending.tournament, tokens);
      return { purpose: 'tournament', tournamentId };
    }
    const member = await archon(() => userInfo(config, tokens.access_token));
    const previous = await this.deps.store.getLink(user.sub);
    const link = {
      archonUid: member.sub,
      veknId: member.vekn_id,
      linkedAt: this.now().toISOString(),
    };
    const result = await this.deps.store.putLink(user.sub, link, previous?.archonUid);
    if (result === 'taken') {
      throw new ApiError(
        409,
        'archon_taken',
        'That Archon account is linked to another Torn Signpost account',
      );
    }
    return { purpose: 'profile', link: { linked: true, ...link } };
  }

  async unlink(identity: Identity): Promise<ArchonLink> {
    const user = requireUser(identity);
    const link = await this.deps.store.getLink(user.sub);
    if (link) await this.deps.store.deleteLink(user.sub, link.archonUid);
    return { linked: false };
  }
}

/** Archon's refusals and outages as API errors: 503 when it's down, 400 when it refused. */
export async function archon<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (!(e instanceof ArchonError)) throw e;
    if (e.retryable) {
      throw new ApiError(503, 'archon_unavailable', 'Archon is unavailable: try again shortly');
    }
    throw new ApiError(400, 'archon_refused', `Archon refused: ${e.message}`);
  }
}

export function requireUser(identity: Identity) {
  if (identity.kind !== 'user') throw new ApiError(401, 'sign_in', 'Sign in first');
  return identity;
}
