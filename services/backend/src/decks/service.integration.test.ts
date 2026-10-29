import { seededRng } from '@torn-signpost/engine';
import type { SaveDeckRequest } from '@torn-signpost/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Identity } from '../auth.ts';
import { DeckStore } from '../db/decks.ts';
import type { GameStore } from '../db/store.ts';
import { GameService } from '../games/service.ts';
import { testContent, testDeck } from '../testing/content.ts';
import { dynamoAvailable, testStore } from '../testing/dynamo.ts';
import { DeckService } from './service.ts';

const available = await dynamoAvailable();
const user = (sub: string): Identity => ({ kind: 'user', sub, name: sub, groups: [] });
const alice = user('alice');
const bob = user('bob');
const guest: Identity = { kind: 'guest' };

let n = 0;
const save = (extra: Partial<SaveDeckRequest> = {}): SaveDeckRequest => ({
  name: 'Vera Bleed',
  format: 'standard',
  visibility: 'private',
  cards: testDeck,
  ...extra,
});

describe.skipIf(!available)('decks (DynamoDB Local)', () => {
  let store: GameStore;
  let decks: DeckService;
  let cleanup: () => Promise<void>;
  beforeAll(async () => {
    const t = await testStore();
    ({ store, cleanup } = t);
    const db = (store as unknown as { db: ConstructorParameters<typeof DeckStore>[0] }).db;
    const table = (store as unknown as { table: string }).table;
    decks = new DeckService({
      store: new DeckStore(db, table),
      content: testContent,
      newId: () => `d${++n}`,
    });
  });
  afterAll(() => cleanup?.());

  it('creates decks and versions the card list on every change (DECK-07)', async () => {
    const d = await decks.create(alice, save({ notes: 'Bleed for 3' }));
    expect(d).toMatchObject({
      version: 1,
      cryptCount: 12,
      libraryCount: 60,
      legal: true,
      notes: 'Bleed for 3',
    });
    const renamed = await decks.update(alice, d.id, save({ name: 'Renamed' }));
    expect(renamed.version).toBe(1);
    const changed = await decks.update(
      alice,
      d.id,
      save({ cards: { ...testDeck, library: [{ id: 't-feed', count: 59 }] } }),
    );
    expect(changed).toMatchObject({ version: 2, libraryCount: 59, legal: false });
    expect((await decks.version(alice, d.id, 1)).cards).toEqual(testDeck);
    expect((await decks.get(alice, d.id)).cards.library).toEqual([{ id: 't-feed', count: 59 }]);
    await expect(decks.update(bob, d.id, save())).rejects.toMatchObject({ status: 404 });
    await expect(
      decks.create(alice, save({ cards: { crypt: [{ id: 'nope', count: 1 }], library: [] } })),
    ).rejects.toMatchObject({
      code: 'unknown_card',
    });
  });

  it('keeps private decks private and lists public ones for everyone (DECK-03)', async () => {
    const priv = await decks.create(alice, save({ name: 'Secret' }));
    const pub = await decks.create(
      alice,
      save({ name: 'Shared', visibility: 'public', format: 'v5' }),
    );
    await expect(decks.get(bob, priv.id)).rejects.toMatchObject({ status: 404 });
    await expect(decks.get(guest, priv.id)).rejects.toMatchObject({ status: 404 });
    expect((await decks.get(guest, pub.id)).name).toBe('Shared');
    expect((await decks.listPublic('v5')).map((d) => d.id)).toEqual([pub.id]);
    expect((await decks.mine(alice)).map((d) => d.name)).toEqual(
      expect.arrayContaining(['Secret', 'Shared']),
    );
    await decks.delete(alice, priv.id);
    await expect(decks.get(alice, priv.id)).rejects.toMatchObject({ status: 404 });
    await expect(decks.delete(bob, pub.id)).rejects.toMatchObject({ status: 404 });
  });

  it('joins games with a saved deck version, which must be legal in the game’s format', async () => {
    const games = new GameService({
      store,
      content: testContent,
      decks,
      rng: seededRng(1),
      publisher: { publish: async () => {} },
      newId: () => `g${++n}`,
    });
    const legal = await decks.create(bob, save());
    const g = await games.create(alice, {
      name: 'Deck game',
      format: 'standard',
      visibility: 'public',
      maxSeats: 3,
    });
    await games.join(bob, g.id, { deckId: legal.id });
    await decks.update(
      bob,
      legal.id,
      save({ cards: { ...testDeck, library: [{ id: 't-feed', count: 10 }] } }),
    );
    await expect(games.join(alice, g.id, { deckId: legal.id, version: 2 })).rejects.toMatchObject({
      status: 404,
    });
    const mine = await decks.create(
      alice,
      save({ cards: { ...testDeck, library: [{ id: 't-feed', count: 10 }] } }),
    );
    await expect(games.join(alice, g.id, { deckId: mine.id })).rejects.toMatchObject({
      code: 'illegal_deck',
    });
    const meta = await store.getMeta(g.id);
    expect(meta?.players[0]).toMatchObject({ user: 'bob', deckRef: { id: legal.id, version: 1 } });
  });
});
