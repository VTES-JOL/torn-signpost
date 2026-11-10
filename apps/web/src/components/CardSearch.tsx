/** Card search with filters (DECK-02); used by the card browser and the deck builder. */
import {
  type CardQuery,
  type CardRecord,
  type Format,
  SECTS,
  searchCards,
} from '@torn-signpost/cards';
import { useDeferredValue, useMemo, useState } from 'react';
import { useCards } from '../content.tsx';
import { useCardPreview } from './CardPreview.tsx';
import { cardMeta, useRemembered } from './cardMeta.ts';

const PAGE = 60;

export interface CardSearchProps {
  /** Adds one copy (deck builder): an add button on each result, and Enter adds the first. */
  onPick?: (card: CardRecord) => void;
  /** Removes one copy (deck builder), for cards already in the deck. */
  onRemove?: (card: CardRecord) => void;
  /** Copies of each card in the deck, shown on its result. */
  counts?: ReadonlyMap<string, number>;
  onOpen: (card: CardRecord) => void;
  format?: Format | undefined;
  /** In the deck builder: a narrower column, so filters start folded and results as a list. */
  compact?: boolean;
}

type Kind = CardQuery['kind'];

export function CardSearch({ onPick, onRemove, counts, onOpen, format, compact }: CardSearchProps) {
  const cards = useCards();
  const [q, setQ] = useState<CardQuery>({});
  const [shown, setShown] = useState(PAGE);
  const [view, setView] = useRemembered<'list' | 'grid'>(
    compact ? 'ts.search.view.deck' : 'ts.search.view.cards',
    compact ? 'list' : 'grid',
  );
  const [more, setMore] = useState(!compact);
  const { bind, preview } = useCardPreview();
  const query = useDeferredValue(q);
  const set = (patch: { [K in keyof CardQuery]?: CardQuery[K] | undefined }) => {
    setShown(PAGE);
    setQ((prev) => {
      // Drop cleared filters so the query only holds active ones.
      const merged: Record<string, unknown> = { ...prev, ...patch };
      for (const [k, v] of Object.entries(merged)) {
        if (v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) delete merged[k];
      }
      return merged as CardQuery;
    });
  };
  // Filters folded under "More filters" that are set, so a folded filter is never forgotten.
  const folded = Object.keys(q).filter((k) => k !== 'name' && k !== 'kind').length;

  const options = useMemo(() => {
    if (cards.state !== 'ready') return { types: [], clans: [], disciplines: [] };
    const types = new Set<string>();
    const clans = new Set<string>();
    const disciplines = new Set<string>();
    for (const c of cards.index.cards) {
      for (const t of c.types) types.add(t);
      for (const cl of c.clans ?? []) clans.add(cl);
      for (const d of c.disciplines ?? []) disciplines.add(d.toLowerCase());
    }
    const sorted = (s: Set<string>) => [...s].sort((a, b) => a.localeCompare(b));
    return { types: sorted(types), clans: sorted(clans), disciplines: sorted(disciplines) };
  }, [cards]);

  const results = useMemo(
    () =>
      cards.state === 'ready'
        ? searchCards(cards.index, { ...query, ...(format ? { format } : {}) })
        : [],
    [cards, query, format],
  );

  if (cards.state === 'loading') return <p className="muted">Loading cards…</p>;
  if (cards.state === 'error') return <p className="notice">{cards.error}</p>;

  const count = (card: CardRecord) => counts?.get(card.id) ?? 0;
  const addRemove = (card: CardRecord) =>
    onPick && (
      <span className="add-remove">
        {onRemove && count(card) > 0 && (
          <button
            type="button"
            onClick={() => onRemove(card)}
            aria-label={`Remove one ${card.name}`}
          >
            −
          </button>
        )}
        <button
          type="button"
          className="add"
          onClick={() => onPick(card)}
          aria-label={`Add ${card.name}`}
        >
          +
        </button>
      </span>
    );
  const inDeck = (card: CardRecord) =>
    count(card) > 0 && (
      <span className="in-deck" title={`${count(card)} in the deck`}>
        ×{count(card)}
      </span>
    );

  return (
    <div className={compact ? 'search compact' : 'search'}>
      <search className="filters">
        <div className="filter-main">
          <input
            type="search"
            placeholder={onPick ? 'Card name (Enter adds the first)' : 'Card name'}
            aria-label="Card name"
            value={q.name ?? ''}
            onChange={(e) => set({ name: e.target.value })}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || !onPick || !q.name || cards.state !== 'ready') return;
              // Search now, not the deferred results, which can lag behind fast typing.
              const first = searchCards(cards.index, { ...q, ...(format ? { format } : {}) })[0];
              if (first) {
                e.preventDefault();
                onPick(first);
              }
            }}
          />
          <fieldset className="segmented" aria-label="Crypt or library">
            {(
              [
                [undefined, 'All'],
                ['crypt', 'Crypt'],
                ['library', 'Library'],
              ] as [Kind, string][]
            ).map(([kind, label]) => (
              <button
                key={label}
                type="button"
                aria-pressed={q.kind === kind}
                onClick={() => set({ kind })}
              >
                {label}
              </button>
            ))}
          </fieldset>
        </div>
        <details open={more} onToggle={(e) => setMore(e.currentTarget.open)}>
          <summary>More filters{folded > 0 && ` (${folded} set)`}</summary>
          <div className="filter-grid">
            <input
              type="search"
              placeholder="Card text"
              aria-label="Card text"
              value={q.text ?? ''}
              onChange={(e) => set({ text: e.target.value })}
            />
            <Select
              label="Type"
              value={q.types?.[0]}
              options={options.types}
              onChange={(v) => set({ types: v ? [v] : [] })}
            />
            <Select
              label="Clan"
              value={q.clans?.[0]}
              options={options.clans}
              onChange={(v) => set({ clans: v ? [v] : [] })}
            />
            <Select
              label="Discipline"
              value={q.disciplines?.[0]}
              options={options.disciplines.flatMap((d) => [d, d.toUpperCase()])}
              display={(d) => (d === d.toUpperCase() ? `${d} (superior)` : d)}
              onChange={(v) => set({ disciplines: v ? [v] : [] })}
            />
            <Select
              label="Sect"
              value={q.sect}
              options={[...SECTS]}
              onChange={(v) => set({ sect: v })}
            />
            <Select
              label="Group"
              value={q.groups?.[0]}
              options={['1', '2', '3', '4', '5', '6', '7']}
              display={(g) => `Group ${g}`}
              onChange={(v) => set({ groups: v ? [v] : [] })}
            />
            <label className="capacity">
              Capacity
              <input
                type="number"
                min={1}
                max={11}
                aria-label="Minimum capacity"
                value={q.capacity?.min ?? ''}
                onChange={(e) => set({ capacity: range(e.target.value, q.capacity?.max) })}
              />
              –
              <input
                type="number"
                min={1}
                max={11}
                aria-label="Maximum capacity"
                value={q.capacity?.max ?? ''}
                onChange={(e) => set({ capacity: range(q.capacity?.min, e.target.value) })}
              />
            </label>
            {!format && (
              <Select
                label="Format"
                value={q.format}
                options={['standard', 'v5']}
                display={(f) => (f === 'v5' ? 'V5 legal' : 'Standard legal')}
                onChange={(v) => set({ format: v as Format | undefined })}
              />
            )}
          </div>
        </details>
      </search>
      <div className="results-head">
        <span className="muted" aria-live="polite">
          {results.length} {results.length === 1 ? 'card' : 'cards'}
        </span>
        {Object.keys(q).length > 0 && (
          <button type="button" className="link" onClick={() => setQ({})}>
            Clear filters
          </button>
        )}
        <fieldset className="segmented" aria-label="Show results as">
          <button type="button" aria-pressed={view === 'list'} onClick={() => setView('list')}>
            List
          </button>
          <button type="button" aria-pressed={view === 'grid'} onClick={() => setView('grid')}>
            Grid
          </button>
        </fieldset>
      </div>
      {view === 'list' ? (
        <ul className="result-rows">
          {results.slice(0, shown).map((card) => (
            <li key={card.id} {...bind(card)}>
              <img
                src={cards.image(card.id, 'thumb')}
                alt=""
                loading="lazy"
                width={32}
                height={45}
                onError={(e) => {
                  e.currentTarget.src = cards.back(card.kind, 'thumb');
                }}
              />
              <button type="button" className="link row-name" onClick={() => onOpen(card)}>
                <span>{card.name}</span>
                <span className="muted small">{cardMeta(card)}</span>
              </button>
              {inDeck(card)}
              {addRemove(card)}
            </li>
          ))}
        </ul>
      ) : (
        <ul className="results">
          {results.slice(0, shown).map((card) => (
            <li key={card.id} {...bind(card)}>
              <button
                type="button"
                className="thumb"
                onClick={() => onOpen(card)}
                title={card.name}
              >
                <img
                  src={cards.image(card.id, 'thumb')}
                  alt=""
                  loading="lazy"
                  width={160}
                  height={223}
                  onError={(e) => {
                    e.currentTarget.src = cards.back(card.kind, 'thumb');
                  }}
                />
                <span>{card.name}</span>
              </button>
              {inDeck(card)}
              {addRemove(card)}
            </li>
          ))}
        </ul>
      )}
      {results.length > shown && (
        <button type="button" onClick={() => setShown((n) => n + PAGE)}>
          Show more
        </button>
      )}
      {preview}
    </div>
  );
}

function range(min: string | number | undefined, max: string | number | undefined) {
  const n = (v: string | number | undefined) =>
    v === '' || v === undefined ? undefined : Number(v);
  const r: { min?: number; max?: number } = {};
  const lo = n(min);
  const hi = n(max);
  if (lo !== undefined) r.min = lo;
  if (hi !== undefined) r.max = hi;
  return lo === undefined && hi === undefined ? undefined : r;
}

function Select(props: {
  label: string;
  value: string | undefined;
  options: string[];
  onChange: (v: string | undefined) => void;
  display?: (v: string) => string;
}) {
  return (
    <select
      aria-label={props.label}
      value={props.value ?? ''}
      onChange={(e) => props.onChange(e.target.value || undefined)}
    >
      <option value="">Any {props.label.toLowerCase()}</option>
      {props.options.map((o) => (
        <option key={o} value={o}>
          {props.display ? props.display(o) : o}
        </option>
      ))}
    </select>
  );
}
