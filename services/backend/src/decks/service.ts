/** Deck builder storage (DECK-03/04/07). Public decks are readable by anyone, including guests. */
import { deckSize, sameCards, validateDeck } from '@torn-signpost/cards';
import type {
  DeckCards,
  DeckDetails,
  DeckSummary,
  DeckVersion,
  SaveDeckRequest,
} from '@torn-signpost/protocol';
import type { Identity } from '../auth.ts';
import type { Content } from '../content/catalog.ts';
import type { DeckMeta, DeckStore } from '../db/decks.ts';
import { ApiError } from '../errors.ts';

export interface DeckServiceDeps {
  store: DeckStore;
  content: Content;
  newId: () => string;
  now?: () => Date;
}

export class DeckService {
  private readonly now: () => Date;

  constructor(private readonly deps: DeckServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async create(identity: Identity, req: SaveDeckRequest): Promise<DeckDetails> {
    const user = requireUser(identity);
    const at = this.now().toISOString();
    const meta: DeckMeta = {
      id: this.deps.newId(),
      name: req.name,
      format: req.format,
      visibility: req.visibility,
      owner: user.sub,
      ownerName: user.name,
      version: 1,
      ...(await this.check(req.cards, req.format)),
      createdAt: at,
      updatedAt: at,
      ...(req.notes ? { notes: req.notes } : {}),
    };
    await this.deps.store.create(meta, req.cards);
    return { ...meta, cards: req.cards };
  }

  /** Save changes; a changed card list becomes a new version. */
  async update(identity: Identity, id: string, req: SaveDeckRequest): Promise<DeckDetails> {
    const user = requireUser(identity);
    const current = await this.owned(user.sub, id);
    const latest = await this.deps.store.version(id, current.version);
    const cardsChanged = !latest || !sameCards(latest.cards, req.cards);
    const meta: DeckMeta = {
      ...current,
      name: req.name,
      format: req.format,
      visibility: req.visibility,
      ownerName: user.name,
      version: current.version + (cardsChanged ? 1 : 0),
      ...(await this.check(req.cards, req.format)),
      updatedAt: this.now().toISOString(),
    };
    delete meta.notes;
    if (req.notes) meta.notes = req.notes;
    const ok = await this.deps.store.update(
      meta,
      current.version,
      cardsChanged ? req.cards : undefined,
    );
    if (!ok) throw new ApiError(409, 'stale', 'The deck was changed elsewhere; reload it');
    return { ...meta, cards: req.cards };
  }

  async get(identity: Identity, id: string): Promise<DeckDetails> {
    const meta = await this.readable(identity, id);
    const latest = await this.deps.store.version(id, meta.version);
    if (!latest) throw new ApiError(404, 'not_found', 'No such deck');
    return { ...meta, cards: latest.cards };
  }

  async version(identity: Identity, id: string, version: number): Promise<DeckVersion> {
    const meta = await this.readable(identity, id);
    const v = version <= meta.version ? await this.deps.store.version(id, version) : undefined;
    if (!v) throw new ApiError(404, 'not_found', 'No such version');
    return v;
  }

  async delete(identity: Identity, id: string): Promise<void> {
    const user = requireUser(identity);
    if (!(await this.deps.store.delete(id, user.sub)))
      throw new ApiError(404, 'not_found', 'No such deck');
  }

  mine(identity: Identity): Promise<DeckSummary[]> {
    return this.deps.store.listOwned(requireUser(identity).sub);
  }

  listPublic(format: string): Promise<DeckSummary[]> {
    return this.deps.store.listPublic(format);
  }

  /** The cards of a deck version the identity may use (their own, or a public deck). */
  async cardsFor(identity: Identity, id: string, version?: number): Promise<DeckCards> {
    const meta = await this.readable(identity, id);
    return (await this.version(identity, id, version ?? meta.version)).cards;
  }

  private async check(cards: DeckCards, format: DeckMeta['format']) {
    const { index } = await this.deps.content();
    for (const { id } of [...cards.crypt, ...cards.library]) {
      if (!index.byId.has(id)) throw new ApiError(422, 'unknown_card', `Unknown card ${id}`);
    }
    return {
      cryptCount: deckSize(cards.crypt),
      libraryCount: deckSize(cards.library),
      legal: validateDeck(cards, index, format).every((i) => i.level !== 'error'),
    };
  }

  private async owned(sub: string, id: string): Promise<DeckMeta> {
    const meta = await this.deps.store.get(id);
    if (!meta || meta.owner !== sub) throw new ApiError(404, 'not_found', 'No such deck');
    return meta;
  }

  private async readable(identity: Identity, id: string): Promise<DeckMeta> {
    const meta = await this.deps.store.get(id);
    const mine = identity.kind === 'user' && meta?.owner === identity.sub;
    if (!meta || (meta.visibility !== 'public' && !mine))
      throw new ApiError(404, 'not_found', 'No such deck');
    return meta;
  }
}

function requireUser(identity: Identity) {
  if (identity.kind !== 'user') throw new ApiError(401, 'sign_in', 'Sign in first');
  return identity;
}
