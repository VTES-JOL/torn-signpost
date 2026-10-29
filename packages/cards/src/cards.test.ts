import { describe, expect, it } from 'vitest';
import { addCard, type DeckCards, expand, exportJson, exportText, importDeck } from './deck.ts';
import { CARDS } from './fixtures.test-data.ts';
import { fromKrcg, type KrcgCard, sectOf } from './krcg.ts';
import { createIndex, searchCards } from './search.ts';
import { deckStats } from './stats.ts';
import { isLegal, validateDeck } from './validate.ts';

const index = createIndex(CARDS);
const names = (cards: { name: string }[]) => cards.map((c) => c.name);
const deck = (crypt: [string, number][], library: [string, number][]): DeckCards => ({
  crypt: crypt.map(([id, count]) => ({ id, count })),
  library: library.map(([id, count]) => ({ id, count })),
});

describe('fromKrcg', () => {
  const krcg: KrcgCard = {
    id: 299999,
    name: 'Invented Elder (G3 ADV)',
    printed_name: 'Invented Elder',
    types: ['Vampire'],
    clans: ['Testers'],
    disciplines: ['AUS', 'dom'],
    capacity: 8,
    group: '3',
    adv: true,
    card_text: 'Advanced, Sabbat bishop: Invented Elder gets +1 bleed.',
    sets: { 'Sabbat V5': [], 'Old Set': [] },
    legality: '2025-10-26',
    name_variants: ['Invented Elder (ADV)'],
  };

  it('normalises a vampire', () => {
    expect(fromKrcg(krcg)).toEqual({
      id: '299999',
      name: 'Invented Elder (G3 ADV)',
      printedName: 'Invented Elder',
      kind: 'crypt',
      types: ['Vampire'],
      clans: ['Testers'],
      disciplines: ['AUS', 'dom'],
      capacity: 8,
      group: '3',
      advanced: true,
      sect: 'Sabbat',
      text: krcg.card_text,
      sets: ['Sabbat V5', 'Old Set'],
      legalFrom: '2025-10-26',
      v5: true,
      aliases: ['Invented Elder (ADV)', 'Invented Elder'],
      artists: [],
    });
  });

  it('marks library discipline requirements as any-of or all-of', () => {
    const lib = (extra: Partial<KrcgCard>) =>
      fromKrcg({
        ...krcg,
        types: ['Combat'],
        disciplines: ['cel', 'pot'],
        adv: false,
        card_text: '',
        ...extra,
      });
    expect(lib({ multidisc: true }).disciplineMode).toBe('any');
    expect(lib({ combo: true }).disciplineMode).toBe('all');
    expect(lib({}).kind).toBe('library');
    expect(lib({}).sect).toBeUndefined();
  });

  it('reads the sect from the first clause only', () => {
    expect(sectOf('Independent: can block Sabbat vampires.')).toBe('Independent');
    expect(sectOf('Laibon magaji: something.')).toBe('Laibon');
    expect(sectOf('Some ability with no sect')).toBeUndefined();
  });
});

describe('searchCards', () => {
  it('matches names fuzzily, best first', () => {
    expect(names(searchCards(index, { name: 'vera' }))).toEqual([
      'Vera Nightfall (G2)',
      'Vera Nightfall (G5)',
    ]);
    expect(names(searchCards(index, { name: 'night' }))[0]).toBe('Night Errand');
    expect(names(searchCards(index, { name: 'ilse varga' }))).toEqual(['Ilse Várga (G3)']);
    expect(names(searchCards(index, { name: 'qkfd' }))).toEqual(['Quick Feed']);
  });

  it('filters by kind, type, clan, sect, discipline, capacity, group, text and format', () => {
    expect(searchCards(index, { kind: 'library', types: ['Master'] })).toHaveLength(2);
    expect(names(searchCards(index, { clans: ['Other'] }))).toEqual(['Vera Nightfall (G5)']);
    expect(names(searchCards(index, { sect: 'Sabbat' }))).toEqual(['Tomas Grey (G2)']);
    expect(names(searchCards(index, { kind: 'crypt', disciplines: ['AUS'] }))).toEqual([
      'Ilse Várga (G3)',
    ]);
    expect(searchCards(index, { kind: 'crypt', disciplines: ['aus'] })).toHaveLength(6);
    expect(names(searchCards(index, { kind: 'library', disciplines: ['pot'] }))).toEqual([
      'Twin Strike',
    ]);
    expect(names(searchCards(index, { capacity: { min: 8 } }))).toEqual([
      'Ilse Várga (G3)',
      'Vera Nightfall (G5)',
    ]);
    expect(names(searchCards(index, { groups: ['6'] }))).toEqual([
      'Old Marek (G6)',
      'Wanderer (GANY)',
    ]);
    expect(names(searchCards(index, { text: 'prince testville' }))).toEqual([
      'Vera Nightfall (G2)',
    ]);
    expect(names(searchCards(index, { kind: 'crypt', format: 'v5' }))).toEqual([
      'Ilse Várga (G3)',
      'Tomas Grey (G2)',
      'Wanderer (GANY)',
    ]);
  });
});

describe('importDeck', () => {
  it('reads TWDA text, using the group to pick between same-named vampires', () => {
    const twda = `Deck Name: Test Deck
Created by: Someone

Crypt (12 cards, min=14, max=32, avg=6.5)
-----------------------------------------
6x Vera Nightfall      7  aus DOM  prince  Testers:2
4x Tomas Grey          4  cel pot          Testers:2
2x Ilse Várga          9  AUS CEL          Testers:3

Library (6 cards)
Master (3)
3x Quick Feed
Action (2)
Night Errand x2
1 Iron Ward
`;
    const { deck, name, issues } = importDeck(twda, index);
    expect(issues).toEqual([]);
    expect(name).toBe('Test Deck');
    expect(deck).toEqual({
      crypt: [
        { id: '201', count: 6 },
        { id: '203', count: 4 },
        { id: '205', count: 2 },
      ],
      library: [
        { id: '101', count: 3 },
        { id: '102', count: 2 },
        { id: '103', count: 1 },
      ],
    });
  });

  it('reports unknown and ambiguous cards with their line', () => {
    const { issues } = importDeck('2x Vera Nightfall\n1x Mystery Card', index);
    expect(issues).toEqual([
      {
        line: 1,
        text: '2x Vera Nightfall',
        message: '"Vera Nightfall" could be Vera Nightfall (G2) or Vera Nightfall (G5)',
      },
      { line: 2, text: '1x Mystery Card', message: 'Unknown card "Mystery Card"' },
    ]);
  });

  it('reads KRCG-style JSON', () => {
    const json = JSON.stringify({
      name: 'From JSON',
      crypt: { count: 2, cards: [{ id: 205, count: 2, name: 'Ilse Várga (G3)' }] },
      library: {
        cards: [
          { type: 'Master', cards: [{ id: 101, count: 3 }] },
          { name: 'Iron Ward', count: 1 },
        ],
      },
    });
    expect(importDeck(json, index)).toEqual({
      name: 'From JSON',
      deck: {
        crypt: [{ id: '205', count: 2 }],
        library: [
          { id: '101', count: 3 },
          { id: '103', count: 1 },
        ],
      },
      issues: [],
    });
  });

  it('round-trips through its own text and JSON exports', () => {
    const original = deck(
      [
        ['202', 3],
        ['204', 2],
        ['207', 1],
      ],
      [
        ['101', 4],
        ['104', 2],
      ],
    );
    const sort = (d: DeckCards) => ({
      crypt: [...d.crypt].sort((a, b) => a.id.localeCompare(b.id)),
      library: [...d.library].sort((a, b) => a.id.localeCompare(b.id)),
    });
    const text = importDeck(exportText(original, index, 'Mine'), index);
    expect(text.issues).toEqual([]);
    expect(text.name).toBe('Mine');
    expect(sort(text.deck)).toEqual(sort(original));
    expect(sort(importDeck(exportJson(original, index), index).deck)).toEqual(sort(original));
  });
});

describe('editing', () => {
  it('adds and removes copies, dropping empty entries', () => {
    let d = addCard({ crypt: [], library: [] }, CARDS[0] as (typeof CARDS)[0], 2, index);
    d = addCard(d, CARDS[0] as (typeof CARDS)[0], -1, index);
    expect(d.crypt).toEqual([{ id: '201', count: 1 }]);
    d = addCard(d, CARDS[0] as (typeof CARDS)[0], -1, index);
    expect(d.crypt).toEqual([]);
    expect(expand(deck([['203', 2]], [['101', 1]]))).toEqual({
      crypt: ['203', '203'],
      library: ['101'],
    });
  });
});

describe('validateDeck', () => {
  const legal = deck(
    [
      ['201', 6],
      ['203', 6],
    ],
    [
      ['101', 30],
      ['102', 30],
    ],
  );
  const codes = (d: DeckCards, f: 'standard' | 'v5' = 'standard') =>
    validateDeck(d, index, f, '2026-01-01').map((i) => i.code);

  it('accepts a legal standard deck', () => {
    expect(codes(legal)).toEqual([]);
  });

  it('checks sizes, grouping, bans, release dates and the V5 pool', () => {
    expect(codes(deck([['201', 11]], [['101', 59]]))).toEqual(['crypt-size', 'library-size']);
    expect(codes(deck([['201', 11]], [['101', 91]]))).toContain('library-size');
    expect(codes({ ...legal, crypt: [...legal.crypt, { id: '206', count: 1 }] })).toEqual([
      'grouping',
    ]);
    expect(codes({ ...legal, crypt: [...legal.crypt, { id: '207', count: 1 }] })).toEqual([]);
    expect(codes({ ...legal, library: [...legal.library, { id: '105', count: 1 }] })).toEqual([
      'banned',
    ]);
    expect(codes({ ...legal, library: [...legal.library, { id: '106', count: 1 }] })).toEqual([
      'not-yet-legal',
    ]);
    expect(codes(legal, 'v5')).toEqual(['not-in-format']);
    expect(codes({ crypt: [{ id: '101', count: 12 }], library: legal.library })).toEqual([
      'wrong-section',
    ]);
    expect(isLegal(CARDS[1] as (typeof CARDS)[0], 'v5', '2026-01-01')).toBe(false);
  });
});

describe('deckStats', () => {
  it('summarises capacity, clans, disciplines and library types', () => {
    const s = deckStats(
      deck(
        [
          ['201', 2],
          ['205', 1],
        ],
        [
          ['101', 3],
          ['103', 2],
          ['104', 1],
        ],
      ),
      index,
    );
    expect(s.crypt).toEqual({
      count: 3,
      capacity: { min: 7, max: 9, average: 7.67 },
      curve: { 7: 2, 9: 1 },
      clans: { Testers: 3 },
      disciplines: {
        aus: { superior: 1, inferior: 2 },
        dom: { superior: 2, inferior: 0 },
        cel: { superior: 1, inferior: 0 },
      },
    });
    expect(s.library).toEqual({
      count: 6,
      types: { Master: 3, Equipment: 2, Combat: 1 },
      disciplines: { cel: 1, pot: 1 },
      clans: {},
      poolCost: 3,
      bloodCost: 4,
    });
  });
});
