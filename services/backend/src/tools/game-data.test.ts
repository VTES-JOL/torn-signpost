import { describe, expect, it } from 'vitest';
import { kindOf, plan } from './game-data.ts';

describe('clearing games', () => {
  it('takes everything games left behind, and keeps accounts and decks', () => {
    const take = [
      { PK: 'GAME#g1', SK: 'META' },
      { PK: 'GAME#g1', SK: 'EV#0000000001' },
      { PK: 'GAME#g1', SK: 'SNAP#0000000001' },
      { PK: 'GAME#g1', SK: 'CMD#c1' },
      { PK: 'GAME#g1', SK: 'MSG#2026#m1' },
      { PK: 'GAME#g1', SK: 'RESULT' },
      { PK: 'SUB#g1', SK: 'CONN#a' },
      { PK: 'JUDGEQ', SK: 'x#g1#c' },
      { PK: 'ADMINQ', SK: 'x#g1#c' },
      { PK: 'DIGESTQ', SK: 'u#n' },
      { PK: 'USER#u', SK: 'GAME#g1' },
      { PK: 'USER#u', SK: 'NOTIF#n' },
      { PK: 'USER#u', SK: 'STATS#all' },
      { PK: 'USER#u', SK: 'STATS#2026' },
    ];
    const keep = [
      { PK: 'USER#u', SK: 'PROFILE' },
      { PK: 'USER#u', SK: 'EMAIL' },
      { PK: 'USER#u', SK: 'EMAILPREFS' },
      { PK: 'USER#u', SK: 'ACTIVE' },
      { PK: 'USER#u', SK: 'DECK#d1' },
      { PK: 'HANDLE#ada', SK: 'HANDLE' },
      { PK: 'DECK#d1', SK: 'META' },
      { PK: 'DECK#d1', SK: 'V#0000000001' },
      { PK: 'CONN#a', SK: 'META' },
      { PK: 'USERCONN#u', SK: 'CONN#a' },
      { PK: 'JUDGES', SK: 'USER#u' },
      { PK: 'ADMINS', SK: 'USER#u' },
    ];
    for (const k of take) expect(kindOf(k), `${k.PK} ${k.SK}`).toBeDefined();
    for (const k of keep) expect(kindOf(k), `${k.PK} ${k.SK}`).toBeUndefined();
    const p = plan([...take, ...keep], 100);
    expect(p.keys).toHaveLength(take.length);
    expect(p.games).toBe(1);
    expect(p.counts).toEqual({
      game: 6,
      subscription: 1,
      queue: 3,
      membership: 1,
      notification: 1,
      stats: 2,
    });
  });

  it('names the games someone is watching, but not ones whose subscriptions have expired', () => {
    const p = plan(
      [
        { PK: 'SUB#g2', SK: 'CONN#a', ttl: 200 },
        { PK: 'SUB#g1', SK: 'CONN#b', ttl: 150 },
        { PK: 'SUB#g3', SK: 'CONN#c', ttl: 50 },
      ],
      100,
    );
    expect(p.watched).toEqual(['g1', 'g2']);
    expect(p.keys).toHaveLength(3);
  });
});
