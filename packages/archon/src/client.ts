/**
 * A tournament through an organiser's `event:run` grant: its token acts on that tournament only.
 * There is no plain GET of a tournament; its state comes from the stream (`/stream?tournament=`):
 * the tournament, the members it names, then `sync_complete`. We read to there and stop.
 */
import { ArchonError } from './errors.ts';
import { type ArchonConfig, call } from './oauth.ts';
import { sseFrames } from './sse.ts';
import type { Action, Member, Tournament } from './types.ts';

export interface TournamentView {
  tournament: Tournament;
  /** The members it names, with only what we keep (no contact details). */
  members: Map<string, Member>;
}

export async function readTournament(
  config: ArchonConfig,
  uid: string,
  accessToken: string,
  opts: { timeoutMs?: number } = {},
): Promise<TournamentView> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), opts.timeoutMs ?? 15_000);
  let text = '';
  try {
    const res = await call(config, `/stream?tournament=${encodeURIComponent(uid)}`, {
      headers: { authorization: `Bearer ${accessToken}`, accept: 'text/event-stream' },
      signal: abort.signal,
    });
    const decoder = new TextDecoder();
    if (res.body) {
      for await (const chunk of res.body) {
        text += decoder.decode(chunk, { stream: true });
        if (text.includes('"sync_complete"')) break;
      }
    }
  } catch (e) {
    if (e instanceof ArchonError) throw e;
    if (!text.includes('"sync_complete"')) {
      throw new ArchonError(0, 'archon.stream', `Couldn't read the tournament: ${String(e)}`);
    }
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
  let tournament: Tournament | undefined;
  const members = new Map<string, Member>();
  for (const frame of sseFrames(text)) {
    let msg: { type?: string; data?: unknown };
    try {
      msg = JSON.parse(frame);
    } catch {
      continue;
    }
    if (msg.type === 'tournament' && (msg.data as Tournament)?.uid === uid) {
      tournament = msg.data as Tournament;
    } else if (msg.type === 'users' && Array.isArray(msg.data)) {
      for (const u of msg.data as Record<string, unknown>[]) {
        if (typeof u.uid !== 'string') continue;
        members.set(u.uid, {
          uid: u.uid,
          name: String(u.nickname || u.name || ''),
          vekn_id: typeof u.vekn_id === 'string' && u.vekn_id ? u.vekn_id : null,
        });
      }
    }
  }
  if (!tournament)
    throw new ArchonError(404, 'archon.no_tournament', `Archon sent no tournament ${uid}`);
  return { tournament, members };
}

/** Send an action; Archon's refusal is thrown as an `ArchonError` (e.g. `tournament.wrong_state`). */
export async function act(
  config: ArchonConfig,
  uid: string,
  accessToken: string,
  action: Action,
): Promise<void> {
  await call(config, `/api/tournaments/${encodeURIComponent(uid)}/action`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(action),
  });
}
