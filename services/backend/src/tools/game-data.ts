/**
 * Which items in the table belong to games, for `games:clear`: everything a game left behind, and
 * the results and stats made from them. Accounts, handles, email settings and decks stay.
 */

export interface Key {
  PK: string;
  SK: string;
  ttl?: number;
}

export type Kind = 'game' | 'subscription' | 'queue' | 'membership' | 'notification' | 'stats';

/** What a game-related item is, or undefined for one to keep. */
export function kindOf(k: Key): Kind | undefined {
  if (k.PK.startsWith('GAME#')) return 'game';
  if (k.PK.startsWith('SUB#')) return 'subscription';
  if (k.PK === 'JUDGEQ' || k.PK === 'ADMINQ' || k.PK === 'DIGESTQ') return 'queue';
  if (k.PK.startsWith('USER#')) {
    if (k.SK.startsWith('GAME#')) return 'membership';
    if (k.SK.startsWith('NOTIF#')) return 'notification';
    if (k.SK.startsWith('STATS#')) return 'stats';
  }
  return undefined;
}

export interface Plan {
  /** Every item to delete. */
  keys: Key[];
  counts: Record<Kind, number>;
  /** How many games: their meta items. */
  games: number;
  /** Games someone is watching right now (a subscription not yet expired). */
  watched: string[];
}

/** Sort a scan of the table into what to delete, given the time in epoch seconds. */
export function plan(items: Key[], nowSeconds: number): Plan {
  const counts: Record<Kind, number> = {
    game: 0,
    subscription: 0,
    queue: 0,
    membership: 0,
    notification: 0,
    stats: 0,
  };
  const keys: Key[] = [];
  const watched = new Set<string>();
  let games = 0;
  for (const item of items) {
    const kind = kindOf(item);
    if (!kind) continue;
    counts[kind]++;
    keys.push({ PK: item.PK, SK: item.SK });
    if (kind === 'game' && item.SK === 'META') games++;
    // DynamoDB removes expired items late, so an expired subscription is nobody watching.
    if (kind === 'subscription' && (item.ttl ?? 0) > nowSeconds) {
      watched.add(item.PK.slice('SUB#'.length));
    }
  }
  return { keys, counts, games, watched: [...watched].sort() };
}
