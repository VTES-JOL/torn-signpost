/**
 * Linking a player's Archon account (docs/m7-plan.md M7.1). The player starts it here; we send
 * them to Archon's consent page for `profile:read` with a PKCE challenge; Archon sends them back
 * to the web app's /archon/callback, which posts the code here; we exchange it with the client
 * secret and ask Archon who they are. We keep their Archon uid and VEKN number, not the tokens.
 */

import { randomBytes } from 'node:crypto';
import {
  type ArchonConfig,
  ArchonError,
  consentUrl,
  exchangeCode,
  pkce,
  userInfo,
} from '@torn-signpost/archon';
import type { ArchonCallbackRequest, ArchonLink, ArchonLinkStart } from '@torn-signpost/protocol';
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
    const user = requireUser(identity);
    const config = await this.deps.config();
    const { verifier, challenge } = pkce();
    const state = randomBytes(24).toString('base64url');
    await this.deps.store.putPending(state, {
      sub: user.sub,
      verifier,
      purpose: 'profile',
      expires: Math.floor(this.now().getTime() / 1000) + SIGN_IN_SECONDS,
    });
    return { url: consentUrl(config, { scope: 'profile:read', state, challenge }) };
  }

  /** Archon sent the player back: finish the link. */
  async complete(identity: Identity, req: ArchonCallbackRequest): Promise<ArchonLink> {
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
    const member = await archon(async () => {
      const tokens = await exchangeCode(config, req.code ?? '', pending.verifier);
      return userInfo(config, tokens.access_token);
    });
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
    return { linked: true, ...link };
  }

  async unlink(identity: Identity): Promise<ArchonLink> {
    const user = requireUser(identity);
    const link = await this.deps.store.getLink(user.sub);
    if (link) await this.deps.store.deleteLink(user.sub, link.archonUid);
    return { linked: false };
  }
}

/** Archon's refusals and outages as API errors: 503 when it's down, 400 when it refused. */
async function archon<T>(f: () => Promise<T>): Promise<T> {
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

function requireUser(identity: Identity) {
  if (identity.kind !== 'user') throw new ApiError(401, 'sign_in', 'Sign in first');
  return identity;
}
