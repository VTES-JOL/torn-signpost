import { type CardCatalog, type CardInfo, createCatalog } from '@torn-signpost/engine';
import testCards from '@torn-signpost/engine/test-catalog.json' with { type: 'json' };

/**
 * The card catalog games are played with. Until the content pack lands (M3) this is the invented
 * test catalog, so no real card data is involved.
 */
export const defaultCatalog: CardCatalog = createCatalog(testCards.cards as CardInfo[]);
