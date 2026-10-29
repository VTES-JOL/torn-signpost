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
import { useNavigate, useParams } from 'react-router';
import { ApiError, useApi } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { CardDetail } from '../components/CardDetail.tsx';
import { CardSearch } from '../components/CardSearch.tsx';
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
  const [importing, setImporting] = useState(false);
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
            disabled={saving || !dirty || !draft.name.trim()}
            onClick={() => void save()}
          >
            Save
          </button>
        )}
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
        <button type="button" onClick={() => download('text')}>
          Export text
        </button>
        <button type="button" onClick={() => download('json')}>
          Export JSON
        </button>
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
        {editable && (
          <div className="panel search-panel">
            <CardSearch
              compact
              onOpen={setOpen}
              onPick={change(1)}
              format={draft.format === 'v5' ? 'v5' : undefined}
            />
          </div>
        )}
        <div className="panel deck-panel">
          <Validation issues={issues} />
          <DeckSection
            title="Crypt"
            entries={draft.cards.crypt}
            editable={editable}
            onOpen={setOpen}
            onChange={(card, n) => change(n)(card)}
          />
          <DeckSection
            title="Library"
            entries={draft.cards.library}
            editable={editable}
            onOpen={setOpen}
            onChange={(card, n) => change(n)(card)}
            groupByType
          />
          {stats && <Stats stats={stats} />}
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

function DeckSection(props: {
  title: string;
  entries: DeckCards['crypt'];
  editable: boolean;
  groupByType?: boolean;
  onOpen: (card: CardRecord) => void;
  onChange: (card: CardRecord, delta: number) => void;
}) {
  const cards = useCards();
  if (cards.state !== 'ready') return null;
  const rows = props.entries.flatMap((e) => {
    const card = cards.get(e.id);
    return card ? [{ card, count: e.count }] : [];
  });
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = props.groupByType ? r.card.types.join(' / ') : '';
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return (
    <div className="deck-section">
      <h2>
        {props.title} ({deckSize(props.entries)})
      </h2>
      {rows.length === 0 && <p className="muted">Empty</p>}
      {[...groups]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([type, list]) => (
          <div key={type}>
            {type && (
              <h3>
                {type} ({list.reduce((n, r) => n + r.count, 0)})
              </h3>
            )}
            <ul>
              {list.map(({ card, count }) => (
                <li key={card.id}>
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
                  <button type="button" className="link" onClick={() => props.onOpen(card)}>
                    {card.name}
                  </button>
                  {card.kind === 'crypt' && <span className="muted">{card.capacity}</span>}
                  {card.disciplines && card.kind === 'crypt' && (
                    <span className="muted">{card.disciplines.join(' ')}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
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
    <details className="stats">
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
