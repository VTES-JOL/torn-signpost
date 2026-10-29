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

const PAGE = 60;

export interface CardSearchProps {
  /** Shown as an add button on each result (deck builder). */
  onPick?: (card: CardRecord) => void;
  onOpen: (card: CardRecord) => void;
  format?: Format | undefined;
  compact?: boolean;
}

export function CardSearch({ onPick, onOpen, format, compact }: CardSearchProps) {
  const cards = useCards();
  const [q, setQ] = useState<CardQuery>({});
  const [shown, setShown] = useState(PAGE);
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

  return (
    <div className={compact ? 'search compact' : 'search'}>
      <search className="filters">
        <input
          type="search"
          placeholder="Card name"
          aria-label="Card name"
          value={q.name ?? ''}
          onChange={(e) => set({ name: e.target.value })}
        />
        <input
          type="search"
          placeholder="Card text"
          aria-label="Card text"
          value={q.text ?? ''}
          onChange={(e) => set({ text: e.target.value })}
        />
        <select
          aria-label="Crypt or library"
          value={q.kind ?? ''}
          onChange={(e) => set({ kind: (e.target.value || undefined) as CardQuery['kind'] })}
        >
          <option value="">Crypt & library</option>
          <option value="crypt">Crypt</option>
          <option value="library">Library</option>
        </select>
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
      </search>
      <p className="muted" aria-live="polite">
        {results.length} {results.length === 1 ? 'card' : 'cards'}
      </p>
      <ul className="results">
        {results.slice(0, shown).map((card) => (
          <li key={card.id}>
            <button type="button" className="thumb" onClick={() => onOpen(card)} title={card.name}>
              {cards.state === 'ready' && (
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
              )}
              <span>{card.name}</span>
            </button>
            {onPick && (
              <button
                type="button"
                className="add"
                onClick={() => onPick(card)}
                aria-label={`Add ${card.name}`}
              >
                +
              </button>
            )}
          </li>
        ))}
      </ul>
      {results.length > shown && (
        <button type="button" onClick={() => setShown((n) => n + PAGE)}>
          Show more
        </button>
      )}
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
