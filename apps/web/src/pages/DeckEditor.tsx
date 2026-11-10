/** Deck builder (DECK-03..07): search, edit counts, validate, stats, import/export, save. */
import {
  addCard,
  type CardRecord,
  type DeckCards,
  deckSize,
  deckStats,
  emptyDeck,
  exportJson,
  exportText,
  type Format,
  importDeck,
  sameCards,
  validateDeck,
} from '@torn-signpost/cards';
import type { DeckDetails, SaveDeckRequest } from '@torn-signpost/protocol';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { ApiError, useApi } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { CardDetail } from '../components/CardDetail.tsx';
import { useCardPreview } from '../components/CardPreview.tsx';
import { CardSearch } from '../components/CardSearch.tsx';
import { cardMeta, useRemembered } from '../components/cardMeta.ts';
import { useCards } from '../content.tsx';

interface Draft {
  name: string;
  format: Format;
  visibility: 'private' | 'public';
  notes: string;
  cards: DeckCards;
}

const blank: Draft = {
  name: 'New deck',
  format: 'standard',
  visibility: 'private',
  notes: '',
  cards: emptyDeck(),
};

export function DeckEditor() {
  const { id } = useParams();
  const api = useApi();
  const { user } = useAuth();
  const cards = useCards();
  const navigate = useNavigate();
  const [saved, setSaved] = useState<DeckDetails>();
  const [draft, setDraft] = useState<Draft>(blank);
  const [open, setOpen] = useState<CardRecord>();
  const [panel, setPanel] = useState<'search' | 'deck'>('deck');
  const [message, setMessage] = useState<string>();
  const [params] = useSearchParams();
  // "Import deck" on the decks page opens a new deck with the import dialog up.
  const [importing, setImporting] = useState(!id && params.has('import'));
  const [deckView, setDeckView] = useRemembered<'list' | 'cards'>('ts.deck.view', 'cards');
  const exportMenu = useRef<HTMLDetailsElement>(null);
  // Guards against a second save (e.g. a double tap) creating a duplicate deck.
  // A ref as well as state: two clicks in the same tick both see the old state.
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  useEffect(() => {
    if (!id) {
      setSaved(undefined);
      setDraft(blank);
      return;
    }
    api<DeckDetails>(`/decks/${id}`).then(
      (d) => {
        setSaved(d);
        setDraft({
          name: d.name,
          format: d.format,
          visibility: d.visibility,
          notes: d.notes ?? '',
          cards: d.cards,
        });
      },
      (e) => setMessage(e instanceof Error ? e.message : String(e)),
    );
  }, [api, id]);

  const owner = !saved || saved.owner === user?.sub;
  const editable = owner && !!user;
  const index = cards.state === 'ready' ? cards.index : undefined;
  const issues = useMemo(
    () => (index ? validateDeck(draft.cards, index, draft.format) : []),
    [index, draft],
  );
  const stats = useMemo(
    () => (index ? deckStats(draft.cards, index) : undefined),
    [index, draft.cards],
  );
  const dirty =
    !saved ||
    draft.name !== saved.name ||
    draft.format !== saved.format ||
    draft.visibility !== saved.visibility ||
    draft.notes !== (saved.notes ?? '') ||
    !sameCards(draft.cards, saved.cards);

  const counts = useMemo(
    () => new Map([...draft.cards.crypt, ...draft.cards.library].map((e) => [e.id, e.count])),
    [draft.cards],
  );
  const empty = draft.cards.crypt.length + draft.cards.library.length === 0;
  // Unsaved: a saved deck that changed, or a new deck with cards in it.
  const unsaved = editable && (saved ? dirty : !empty);
  const canSave = editable && !saving && dirty && !!draft.name.trim();

  // Don't lose unsaved changes: ask before closing the tab, or following a link off the page.
  useEffect(() => {
    if (!unsaved) return;
    const beforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    const onClick = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.('a[href]');
      if (!a || a.getAttribute('target') === '_blank' || e.defaultPrevented) return;
      if (!window.confirm('Leave this deck? Your unsaved changes will be lost.')) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      document.removeEventListener('click', onClick, true);
    };
  }, [unsaved]);

  // The Export menu closes when you click anywhere else.
  useEffect(() => {
    const close = (e: PointerEvent) => {
      const menu = exportMenu.current;
      if (menu?.open && !menu.contains(e.target as Node)) menu.open = false;
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, []);

  // Ctrl/⌘+S saves.
  const saveRef = useRef<() => void>(undefined);
  saveRef.current = canSave ? () => void save() : undefined;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        saveRef.current?.();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const change = (count: number) => (card: CardRecord) => {
    if (!editable) return;
    setDraft((d) => ({ ...d, cards: addCard(d.cards, card, count, index) }));
  };

  const save = async (asCopy = false) => {
    const body: SaveDeckRequest = {
      name: asCopy ? `${draft.name} (copy)` : draft.name,
      format: draft.format,
      visibility: asCopy ? 'private' : draft.visibility,
      cards: draft.cards,
      ...(draft.notes ? { notes: draft.notes } : {}),
    };
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const result =
        saved && !asCopy
          ? await api<DeckDetails>(`/decks/${saved.id}`, { method: 'PUT', body })
          : await api<DeckDetails>('/decks', { method: 'POST', body });
      setSaved(result);
      setMessage(`Saved (version ${result.version})`);
      if (!saved || asCopy) navigate(`/decks/${result.id}`, { replace: !asCopy });
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : String(e));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!saved || !window.confirm(`Delete “${saved.name}”?`)) return;
    await api(`/decks/${saved.id}`, { method: 'DELETE' });
    navigate('/decks');
  };

  const download = (kind: 'text' | 'json') => {
    if (!index) return;
    const content =
      kind === 'text'
        ? exportText(draft.cards, index, draft.name)
        : exportJson(draft.cards, index, draft.name);
    const url = URL.createObjectURL(
      new Blob([content], { type: kind === 'text' ? 'text/plain' : 'application/json' }),
    );
    const a = Object.assign(document.createElement('a'), {
      href: url,
      download: `${draft.name.replace(/[^\w-]+/g, '_')}.${kind === 'text' ? 'txt' : 'json'}`,
    });
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!id && !user) return <p className="notice">Sign in to build decks.</p>;

  return (
    <section className="deck-editor">
      <div className="toolbar">
        <input
          className="deck-name"
          aria-label="Deck name"
          value={draft.name}
          readOnly={!editable}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        />
        <select
          aria-label="Format"
          value={draft.format}
          disabled={!editable}
          onChange={(e) => setDraft({ ...draft, format: e.target.value as Format })}
        >
          <option value="standard">Standard</option>
          <option value="v5">V5</option>
          <option value="duel">Duel</option>
        </select>
        {editable && (
          <select
            aria-label="Visibility"
            value={draft.visibility}
            onChange={(e) =>
              setDraft({ ...draft, visibility: e.target.value as Draft['visibility'] })
            }
          >
            <option value="private">Private</option>
            <option value="public">Public</option>
          </select>
        )}
        {editable && (
          <button
            type="button"
            className="primary"
            disabled={!canSave}
            onClick={() => void save()}
            title="Ctrl/⌘ + S"
          >
            Save
          </button>
        )}
        {unsaved && <span className="muted small unsaved">Unsaved changes</span>}
        {user && saved && !owner && (
          <button type="button" onClick={() => void save(true)}>
            Copy to my decks
          </button>
        )}
        {editable && (
          <button type="button" onClick={() => setImporting(true)}>
            Import
          </button>
        )}
        <details className="menu-button" ref={exportMenu}>
          <summary className="button">Export</summary>
          <div className="menu-items">
            {(['text', 'json'] as const).map((kind) => (
              <button
                key={kind}
                type="button"
                onClick={() => {
                  download(kind);
                  if (exportMenu.current) exportMenu.current.open = false;
                }}
              >
                {kind === 'text' ? 'Text (.txt)' : 'JSON (.json)'}
              </button>
            ))}
          </div>
        </details>
        {editable && saved && (
          <button type="button" className="danger" onClick={() => void remove()}>
            Delete
          </button>
        )}
      </div>
      {message && (
        <p className="muted" role="status">
          {message}
        </p>
      )}
      {saved && !owner && <p className="muted">By {saved.ownerName}</p>}

      <div className="tabs narrow-only" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={panel === 'deck'}
          onClick={() => setPanel('deck')}
        >
          Deck
        </button>
        {editable && (
          <button
            type="button"
            role="tab"
            aria-selected={panel === 'search'}
            onClick={() => setPanel('search')}
          >
            Add cards
          </button>
        )}
      </div>

      <div className={`editor-panels show-${panel}`}>
        <div className="panel deck-panel">
          <div className="deck-head">
            <Validation issues={issues} />
            <fieldset className="segmented" aria-label="Show the deck as">
              <button
                type="button"
                aria-pressed={deckView === 'cards'}
                onClick={() => setDeckView('cards')}
              >
                Cards
              </button>
              <button
                type="button"
                aria-pressed={deckView === 'list'}
                onClick={() => setDeckView('list')}
              >
                List
              </button>
            </fieldset>
          </div>
          <DeckSection
            title="Crypt"
            entries={draft.cards.crypt}
            editable={editable}
            view={deckView}
            onOpen={setOpen}
            onChange={(card, n) => change(n)(card)}
            {...(stats ? { summary: cryptSummary(stats, draft.cards, index) } : {})}
          />
          <DeckSection
            title="Library"
            entries={draft.cards.library}
            editable={editable}
            view={deckView}
            onOpen={setOpen}
            onChange={(card, n) => change(n)(card)}
            groupByType
          />
          {stats && !empty && <Stats stats={stats} />}
          <label className="notes">
            Notes
            <textarea
              value={draft.notes}
              readOnly={!editable}
              rows={4}
              onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
            />
          </label>
        </div>
        {editable && (
          <div className="panel search-panel">
            <CardSearch
              compact
              onOpen={setOpen}
              onPick={change(1)}
              onRemove={change(-1)}
              counts={counts}
              format={draft.format === 'v5' ? 'v5' : undefined}
            />
          </div>
        )}
      </div>

      {importing && index && (
        <ImportDialog
          onClose={() => setImporting(false)}
          onImport={(text, replace) => {
            const result = importDeck(text, index);
            setDraft((d) => {
              let next = replace ? emptyDeck() : d.cards;
              for (const { id: cardId, count } of [...result.deck.crypt, ...result.deck.library]) {
                const card = index.byId.get(cardId);
                if (card) next = addCard(next, card, count, index);
              }
              return { ...d, cards: next, name: replace && result.name ? result.name : d.name };
            });
            return result.issues.map((i) => (i.line ? `Line ${i.line}: ${i.message}` : i.message));
          }}
        />
      )}
      <CardDetail card={open} onClose={() => setOpen(undefined)} />
    </section>
  );
}

/** Library card types in the order deck lists use (TWDA), so a list reads as players expect. */
const TYPE_ORDER = [
  'Master',
  'Conviction',
  'Action',
  'Action Modifier',
  'Political Action',
  'Ally',
  'Equipment',
  'Retainer',
  'Power',
  'Reaction',
  'Combat',
  'Event',
];
const typeRank = (types: string[]) =>
  Math.min(
    ...types.map((t) => (TYPE_ORDER.includes(t) ? TYPE_ORDER.indexOf(t) : TYPE_ORDER.length)),
  );

/** "capacity 3–8, average 7.1 · groups 2" for the crypt's heading. */
function cryptSummary(
  stats: ReturnType<typeof deckStats>,
  deck: DeckCards,
  index: { byId: ReadonlyMap<string, CardRecord> } | undefined,
): string {
  if (stats.crypt.count === 0) return '';
  const groups = [...new Set(deck.crypt.flatMap((e) => index?.byId.get(e.id)?.group ?? []))].sort();
  const c = stats.crypt.capacity;
  return [
    `capacity ${c.min === c.max ? c.min : `${c.min}–${c.max}`}, average ${c.average}`,
    groups.length > 0 && `${groups.length === 1 ? 'group' : 'groups'} ${groups.join(', ')}`,
  ]
    .filter(Boolean)
    .join(' · ');
}

function DeckSection(props: {
  title: string;
  entries: DeckCards['crypt'];
  editable: boolean;
  view: 'list' | 'cards';
  groupByType?: boolean;
  summary?: string;
  onOpen: (card: CardRecord) => void;
  onChange: (card: CardRecord, delta: number) => void;
}) {
  const cards = useCards();
  const { bind, preview } = useCardPreview();
  if (cards.state !== 'ready') return null;
  const rows = props.entries.flatMap((e) => {
    const card = cards.get(e.id);
    return card ? [{ card, count: e.count }] : [];
  });
  // The crypt by capacity, highest first; library cards by name within their type.
  rows.sort(
    (a, b) =>
      (b.card.capacity ?? 0) - (a.card.capacity ?? 0) || a.card.name.localeCompare(b.card.name),
  );
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = props.groupByType ? r.card.types.join(' / ') : '';
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const ordered = [...groups].sort(
    ([a, x], [b, y]) =>
      typeRank(x[0]?.card.types ?? []) - typeRank(y[0]?.card.types ?? []) || a.localeCompare(b),
  );
  const buttons = (card: CardRecord, count: number) => (
    <>
      {props.editable && (
        <button
          type="button"
          aria-label={`Remove one ${card.name}`}
          onClick={() => props.onChange(card, -1)}
        >
          −
        </button>
      )}
      <span className="count">{count}</span>
      {props.editable && (
        <button
          type="button"
          aria-label={`Add one ${card.name}`}
          onClick={() => props.onChange(card, 1)}
        >
          +
        </button>
      )}
    </>
  );
  return (
    <div className="deck-section">
      <h2>
        {props.title} ({deckSize(props.entries)})
        {props.summary && <span className="muted small"> {props.summary}</span>}
      </h2>
      {rows.length === 0 && (
        <p className="muted">Empty{props.editable ? ': add cards from the search.' : ''}</p>
      )}
      <div className={`deck-groups ${props.view}`}>
        {ordered.map(([type, list]) => (
          <div key={type} className="deck-group">
            {type && (
              <h3>
                {type} ({list.reduce((n, r) => n + r.count, 0)})
              </h3>
            )}
            {props.view === 'cards' ? (
              <ul className="deck-cards">
                {list.map(({ card, count }) => (
                  <li key={card.id} {...bind(card)}>
                    <button
                      type="button"
                      className="deck-card"
                      onClick={() => props.onOpen(card)}
                      title={card.name}
                    >
                      <img
                        src={cards.image(card.id, 'thumb')}
                        alt={card.name}
                        loading="lazy"
                        onError={(e) => {
                          e.currentTarget.src = cards.back(card.kind, 'thumb');
                        }}
                      />
                      <span className="copies">×{count}</span>
                    </button>
                    <span className="deck-card-controls">{buttons(card, count)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <ul className="deck-rows">
                {list.map(({ card, count }) => (
                  <li key={card.id}>
                    {buttons(card, count)}
                    <button
                      type="button"
                      className="link"
                      onClick={() => props.onOpen(card)}
                      {...bind(card)}
                    >
                      {card.name}
                    </button>
                    <span className="muted small">
                      {cardMeta(card, { type: !props.groupByType })}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
      {preview}
    </div>
  );
}

function Validation({ issues }: { issues: ReturnType<typeof validateDeck> }) {
  if (issues.length === 0) return <p className="badge ok">Legal</p>;
  return (
    <ul className="issues" aria-label="Deck problems">
      {issues.map((i) => (
        <li key={`${i.code}-${i.cardId ?? ''}`}>{i.message}</li>
      ))}
    </ul>
  );
}

function Stats({ stats }: { stats: ReturnType<typeof deckStats> }) {
  const list = (rec: Record<string, number>) =>
    Object.entries(rec)
      .sort(([, a], [, b]) => b - a)
      .map(([k, v]) => `${k} ${v}`)
      .join(' · ');
  return (
    <details className="stats" open>
      <summary>Statistics</summary>
      <p>
        Crypt capacity {stats.crypt.capacity.min}–{stats.crypt.capacity.max}, average{' '}
        {stats.crypt.capacity.average}
      </p>
      <p>Clans: {list(stats.crypt.clans) || '—'}</p>
      <p>
        Crypt disciplines:{' '}
        {Object.entries(stats.crypt.disciplines)
          .sort(([, a], [, b]) => b.superior + b.inferior - (a.superior + a.inferior))
          .map(([d, n]) => `${d} ${n.inferior}/${n.superior}`)
          .join(' · ') || '—'}
      </p>
      <p>Library types: {list(stats.library.types) || '—'}</p>
      <p>Library disciplines: {list(stats.library.disciplines) || '—'}</p>
      <p>
        Pool cost {stats.library.poolCost} · blood cost {stats.library.bloodCost}
      </p>
    </details>
  );
}

function ImportDialog(props: {
  onClose: () => void;
  onImport: (text: string, replace: boolean) => string[];
}) {
  const [text, setText] = useState('');
  const [problems, setProblems] = useState<string[]>();
  return (
    <dialog open className="import-dialog" aria-label="Import deck">
      <p>Paste a deck list: TWDA, VDB, Amaranth or Lackey text, or KRCG / vtesdecks JSON.</p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={14}
        aria-label="Deck list"
      />
      {problems && problems.length > 0 && (
        <ul className="issues">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <div className="toolbar">
        <button
          type="button"
          className="primary"
          onClick={() => {
            const found = props.onImport(text, true);
            if (found.length) setProblems(found);
            else props.onClose();
          }}
        >
          Replace deck
        </button>
        <button
          type="button"
          onClick={() => {
            const found = props.onImport(text, false);
            if (found.length) setProblems(found);
            else props.onClose();
          }}
        >
          Add to deck
        </button>
        <button type="button" onClick={props.onClose}>
          Close
        </button>
      </div>
    </dialog>
  );
}
