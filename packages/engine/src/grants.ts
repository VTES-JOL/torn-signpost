/**
 * Which cards lift a default flow rule, by VEKN card ID (docs/flow.md, "Overrides"). Rules data
 * only: no names or card text, which live in the content pack (LEGAL-08). A card missing here can
 * still be cited for an override; it is then accepted as unverified.
 *
 * To tag a card, add its VEKN ID with the rules it lifts.
 */
import type { Grant } from './catalog.ts';
import type { CardId } from './model.ts';

export const CARD_GRANTS: Readonly<Record<CardId, readonly Grant[]>> = {
  // Action cards that are bleeds against any Methuselah.
  '101055': ['bleed-any'],
  // Reactions whose superior level attempts to block ignoring prey, predator or target.
  '100598': ['block-any'],
  '100694': ['block-any'],
  // Vampires whose own text lets them bleed any Methuselah.
  '200734': ['bleed-any'],
  // Vampires whose own text lets them block ignoring prey, predator or target.
  '200106': ['block-any'],
};
