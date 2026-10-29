/** Invented cards for tests. Real card data is never committed (LEGAL-08). */
import type { CardRecord } from './model.ts';

const base = {
  sets: ['Test Set'],
  legalFrom: '2000-01-01',
  v5: false,
  aliases: [],
  artists: [],
  text: '',
};

export const vamp = (
  id: string,
  printedName: string,
  group: string,
  capacity: number,
  extra: Partial<CardRecord> = {},
): CardRecord => ({
  ...base,
  id,
  name: `${printedName} (G${group}${extra.advanced ? ' ADV' : ''})`,
  printedName,
  kind: 'crypt',
  types: ['Vampire'],
  clans: ['Testers'],
  group,
  capacity,
  disciplines: ['aus', 'DOM'],
  sect: 'Camarilla',
  aliases: [
    printedName,
    `${printedName} (G${group})`,
    ...(extra.advanced ? [`${printedName} (ADV)`] : []),
  ],
  ...extra,
});

export const card = (
  id: string,
  name: string,
  types: string[],
  extra: Partial<CardRecord> = {},
): CardRecord => ({
  ...base,
  id,
  name,
  printedName: name,
  kind: 'library',
  types,
  ...extra,
});

export const CARDS: CardRecord[] = [
  vamp('201', 'Vera Nightfall', '2', 7, {
    text: 'Camarilla Prince of Testville.',
    title: 'Prince',
  }),
  vamp('202', 'Vera Nightfall', '5', 8, {
    clans: ['Other'],
    aliases: ['Vera Nightfall', 'Vera Nightfall (G5)'],
  }),
  vamp('203', 'Tomas Grey', '2', 4, { disciplines: ['cel', 'pot'], sect: 'Sabbat', v5: true }),
  vamp('204', 'Tomas Grey', '2', 5, { advanced: true }),
  vamp('205', 'Ilse Várga', '3', 9, { disciplines: ['AUS', 'CEL'], v5: true }),
  vamp('206', 'Old Marek', '6', 3),
  vamp('207', 'Wanderer', 'ANY', 6, { v5: true }),
  card('101', 'Quick Feed', ['Master'], { poolCost: '1', v5: true, text: 'Gain 2 blood.' }),
  card('102', 'Night Errand', ['Action'], { disciplines: ['aus'], v5: true }),
  card('103', 'Iron Ward', ['Equipment'], { bloodCost: '2', v5: true }),
  card('104', 'Twin Strike', ['Combat'], { disciplines: ['cel', 'pot'], disciplineMode: 'all' }),
  card('105', 'Forbidden Thing', ['Master'], { bannedFrom: '2010-01-01' }),
  card('106', 'Future Card', ['Action'], { legalFrom: '2099-01-01' }),
];
