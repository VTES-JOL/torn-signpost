import type { CardRecord } from '@torn-signpost/cards';
import { useState } from 'react';

/**
 * One line about a card for lists: a vampire's capacity, disciplines and clan; a library card's
 * type, what it needs (discipline or clan) and what it costs.
 */
export function cardMeta(card: CardRecord, opts: { type?: boolean } = {}): string {
  if (card.kind === 'crypt') {
    return [card.capacity, card.disciplines?.join(' '), card.clans?.join(' / ')]
      .filter((x) => x !== undefined && x !== '')
      .join(' · ');
  }
  const cost = card.poolCost
    ? `${card.poolCost} pool`
    : card.bloodCost
      ? `${card.bloodCost} blood`
      : card.convictionCost
        ? `${card.convictionCost} conviction`
        : undefined;
  return [
    // Under a heading that names the type already, it needn't be said again.
    opts.type !== false && card.types.join(' / '),
    card.disciplines?.join(card.disciplineMode === 'all' ? ' + ' : ' / '),
    card.clans?.join(' / '),
    cost,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** A per-browser choice, such as list or grid, kept between visits when storage allows. */
export function useRemembered<T extends string>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      return (localStorage.getItem(key) as T | null) ?? initial;
    } catch {
      return initial;
    }
  });
  return [
    value,
    (v: T) => {
      setValue(v);
      try {
        localStorage.setItem(key, v);
      } catch {
        // Private mode, or storage blocked: the choice lasts for this visit.
      }
    },
  ];
}
