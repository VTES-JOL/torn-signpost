/**
 * The tabletop (M4): seats in physical order around your own region, cards you can click for
 * actions, drag between zones or onto minions, zoom and inspect (UX-01/02/05/06).
 */
import type { CardRecord } from '@torn-signpost/cards';
import {
  type CardInstance,
  type GameState,
  parseZoneId,
  predator,
  prey,
  type ZoneId,
  type ZoneName,
  zoneId,
} from '@torn-signpost/engine';
import type { PlayerCommand } from '@torn-signpost/protocol';
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api.ts';
import { useCards } from '../content.tsx';
import { cardActions, type MenuItem } from './actions.ts';
import type { GameClient, GameSnapshot } from './client.ts';
import { DragProvider, type DragSource, type DropTarget, useDrag } from './drag.tsx';

interface TableContextValue {
  snapshot: GameSnapshot;
  client: GameClient;
  seat: string | undefined;
  judge: boolean;
  send(command: PlayerCommand): void;
  openMenu(card: CardInstance, anchor: DOMRect): void;
  inspect(card: CardInstance | undefined): void;
  picking: CardInstance | undefined;
  pick(host: CardInstance): void;
  showZone(zone: ZoneId): void;
}

const TableContext = createContext<TableContextValue | undefined>(undefined);
const useTable = () => {
  const t = useContext(TableContext);
  if (!t) throw new Error('useTable outside Table');
  return t;
};

const IN_PLAY: ZoneName[] = ['ready', 'torpor'];

export function Table(props: {
  client: GameClient;
  snapshot: GameSnapshot;
  judge: boolean;
  onError: (m: string) => void;
}) {
  const { client, snapshot, judge, onError } = props;
  const seat = snapshot.seat;
  const view = snapshot.view;
  const [menu, setMenu] = useState<{ card: CardInstance; anchor: DOMRect }>();
  const [inspected, setInspected] = useState<CardInstance>();
  const [picking, setPicking] = useState<CardInstance>();
  const [zoneDialog, setZoneDialog] = useState<ZoneId>();
  const [zoom, setZoom] = useState(1);

  const send = (command: PlayerCommand) => {
    client.send(command).catch((e) => onError(e instanceof ApiError ? e.message : String(e)));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPicking(undefined);
        setMenu(undefined);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const ctx: TableContextValue = {
    snapshot,
    client,
    seat,
    judge,
    send,
    openMenu: (card, anchor) => setMenu({ card, anchor }),
    inspect: setInspected,
    picking,
    pick: (host) => {
      if (picking && host.id !== picking.id)
        send({ type: 'Attach', card: picking.id, to: host.id });
      setPicking(undefined);
    },
    showZone: setZoneDialog,
  };

  // Drag and drop (UX-02): what each drop means.
  const commandFor = (source: DragSource, target: DropTarget): PlayerCommand | undefined => {
    if (source.kind === 'card') {
      const card = view.cards[source.id];
      if (!card) return undefined;
      if (target.kind === 'zone' && target.zone !== card.zone) {
        return { type: 'MoveCard', card: card.id, to: target.zone as ZoneId };
      }
      if (target.kind === 'card' && target.id !== card.id) {
        const host = view.cards[target.id];
        if (host && IN_PLAY.includes(parseZoneId(host.zone).name))
          return { type: 'Attach', card: card.id, to: host.id };
      }
      return undefined;
    }
    if (source.kind === 'deck' && target.kind === 'zone') {
      const want = zoneId(source.seat, source.from === 'crypt' ? 'uncontrolled' : 'hand');
      return target.zone === want
        ? { type: 'Draw', seat: source.seat, from: source.from }
        : undefined;
    }
    if (source.kind === 'pool' && target.kind === 'card') {
      const card = view.cards[target.id];
      const name = card && parseZoneId(card.zone).name;
      if (name && ['ready', 'torpor', 'uncontrolled'].includes(name)) {
        return {
          type: 'TransferBlood',
          from: { pool: source.seat },
          to: { card: target.id },
          amount: 1,
        };
      }
    }
    return undefined;
  };

  return (
    <TableContext.Provider value={ctx}>
      <DragProvider
        accepts={(s, t) => commandFor(s, t) !== undefined}
        onDrop={(s, t) => {
          const command = commandFor(s, t);
          if (command) send(command);
        }}
      >
        <TurnBar zoom={zoom} setZoom={setZoom} />
        {picking && (
          <p className="picking" role="status">
            Choose a minion to attach to, or press Escape.
          </p>
        )}
        <ZoomViewport zoom={zoom} setZoom={setZoom}>
          <Seats view={view} />
        </ZoomViewport>
        {seat && <Hand seat={seat} />}
        {menu && (
          <CardMenu
            card={menu.card}
            anchor={menu.anchor}
            onClose={() => setMenu(undefined)}
            onPick={(card) => setPicking(card)}
          />
        )}
        <Inspector card={inspected} />
        {zoneDialog && <ZoneDialog zone={zoneDialog} onClose={() => setZoneDialog(undefined)} />}
      </DragProvider>
    </TableContext.Provider>
  );
}

/** Opponents across the top in clockwise order from your prey; you at the bottom. */
function Seats({ view }: { view: GameState }) {
  const { seat, client } = useTable();
  const refs = view.seats.map((s) => ({ id: s.id, ousted: !!(s.ousted || s.withdrawn) }));
  const me = seat ?? view.seats[0]?.id;
  const order: string[] = [];
  if (me) {
    const i = view.seats.findIndex((s) => s.id === me);
    for (let n = 1; n < view.seats.length; n++)
      order.push(view.seats[(i + n) % view.seats.length]?.id ?? '');
  }
  const preyOf = me ? prey(refs, me) : undefined;
  const predOf = me ? predator(refs, me) : undefined;
  return (
    <div className="seats">
      <div className="opponents">
        {order.map((id) => (
          <SeatArea
            key={id}
            seat={id}
            label={id === preyOf ? 'prey' : id === predOf ? 'predator' : undefined}
          />
        ))}
      </div>
      {me && <SeatArea seat={me} own={me === seat} label={me === seat ? 'you' : undefined} />}
      <span className="sr-only">{client.seatName(me ?? '')}</span>
    </div>
  );
}

function SeatArea({
  seat,
  own,
  label,
}: {
  seat: string;
  own?: boolean;
  label?: string | undefined;
}) {
  const { snapshot, client, send, judge, showZone } = useTable();
  const { begin } = useDrag();
  const view = snapshot.view;
  const s = view.seats.find((x) => x.id === seat);
  if (!s) return null;
  const count = (z: ZoneName) => view.zones[zoneId(seat, z)]?.length ?? 0;
  const turn = view.turn?.seat === seat;
  const canAct = own || judge;
  return (
    <section
      className={['seat', own ? 'own' : '', turn ? 'turn' : '', s.ousted ? 'ousted' : ''].join(' ')}
      aria-label={`Seat ${seat}: ${client.seatName(seat)}`}
    >
      <header className="seat-header">
        <strong>{client.seatName(seat)}</strong>
        {label && <span className="muted small">{label}</span>}
        {turn && <span className="badge">{view.turn?.phase}</span>}
        {s.hasEdge && <span className="badge ok">Edge</span>}
        <span
          className="pool"
          data-drop={`pool:${seat}`}
          onPointerDown={canAct ? (e) => begin(e, { kind: 'pool', seat }) : undefined}
          title={canAct ? 'Drag onto a vampire to transfer 1 blood' : undefined}
        >
          Pool {s.pool}
        </span>
        <button
          type="button"
          aria-label={`Lower ${client.seatName(seat)}'s pool`}
          onClick={() => send({ type: 'AdjustPool', seat, delta: -1 })}
        >
          −
        </button>
        <button
          type="button"
          aria-label={`Raise ${client.seatName(seat)}'s pool`}
          onClick={() => send({ type: 'AdjustPool', seat, delta: 1 })}
        >
          +
        </button>
        <span>VP {s.vp}</span>
      </header>
      <div className="seat-zones">
        <Zone seat={seat} name="ready" label="Ready" />
        <Zone seat={seat} name="torpor" label="Torpor" />
        <Zone seat={seat} name="uncontrolled" label="Uncontrolled" />
        <div className="stacks">
          <Stack seat={seat} name="crypt" label="Crypt" count={count('crypt')} draggable={canAct} />
          <Stack
            seat={seat}
            name="library"
            label="Library"
            count={count('library')}
            draggable={canAct}
          />
          {!own && <Stack seat={seat} name="hand" label="Hand" count={count('hand')} />}
          <Stack
            seat={seat}
            name="ashHeap"
            label="Ash heap"
            count={count('ashHeap')}
            onOpen={() => showZone(zoneId(seat, 'ashHeap'))}
          />
          {count('removed') > 0 && (
            <Stack
              seat={seat}
              name="removed"
              label="Removed"
              count={count('removed')}
              onOpen={() => showZone(zoneId(seat, 'removed'))}
            />
          )}
          {count('research') > 0 && <Zone seat={seat} name="research" label="Research" />}
        </div>
      </div>
    </section>
  );
}

function Zone({ seat, name, label }: { seat: string; name: ZoneName; label: string }) {
  const { snapshot } = useTable();
  const view = snapshot.view;
  const ids = view.zones[zoneId(seat, name)] ?? [];
  // Attached cards are drawn under their host.
  const roots = ids.filter(
    (id) => !view.cards[id]?.attachedTo || !ids.includes(view.cards[id]?.attachedTo ?? ''),
  );
  return (
    <div className={`zone zone-${name}`} data-drop={`zone:${seat}:${name}`}>
      <span className="zone-label">{label}</span>
      <div className="zone-cards">
        {roots.map((id) => (
          <CardStack key={id} id={id} />
        ))}
      </div>
    </div>
  );
}

function CardStack({ id }: { id: string }) {
  const { snapshot } = useTable();
  const children = Object.values(snapshot.view.cards).filter((c) => c.attachedTo === id);
  return (
    <div className="card-stack">
      <CardView id={id} />
      {children.map((c) => (
        <div key={c.id} className="attached">
          <CardView id={c.id} />
        </div>
      ))}
    </div>
  );
}

function CardView({ id }: { id: string }) {
  const { snapshot, openMenu, inspect, picking, pick, seat, judge } = useTable();
  const cards = useCards();
  const { begin } = useDrag();
  const card = snapshot.view.cards[id];
  const hold = useRef<ReturnType<typeof setTimeout>>(undefined);
  if (!card || cards.state !== 'ready') return null;
  const record = card.cardId ? cards.get(card.cardId) : undefined;
  const zone = parseZoneId(card.zone);
  const kind =
    record?.kind ?? (zone.name === 'crypt' || zone.name === 'uncontrolled' ? 'crypt' : 'library');
  const src = record ? cards.image(record.id, 'thumb') : cards.back(kind, 'thumb');
  const canDrag = judge || zone.seat === seat || card.controller === seat;
  const clear = () => {
    clearTimeout(hold.current);
    inspect(undefined);
  };
  return (
    <button
      type="button"
      className={[
        'card',
        card.locked ? 'locked' : '',
        card.faceDown ? 'face-down' : '',
        card.contested ? 'contested' : '',
      ].join(' ')}
      style={{ viewTransitionName: `c-${card.id}` }}
      data-drop={`card:${card.id}`}
      aria-label={`${record?.name ?? 'Hidden card'}${card.locked ? ', locked' : ''}`}
      onClick={(e) => {
        if (picking) pick(card);
        else openMenu(card, e.currentTarget.getBoundingClientRect());
      }}
      onPointerDown={(e) => {
        if (e.pointerType === 'touch') hold.current = setTimeout(() => inspect(card), 450);
        if (canDrag) begin(e, { kind: 'card', id: card.id, zone: card.zone }, src);
      }}
      onPointerUp={() => clearTimeout(hold.current)}
      onPointerEnter={(e) => {
        if (e.pointerType === 'mouse') hold.current = setTimeout(() => inspect(card), 350);
      }}
      onPointerLeave={clear}
      onContextMenu={(e) => {
        e.preventDefault();
        openMenu(card, e.currentTarget.getBoundingClientRect());
      }}
    >
      <img
        src={src}
        alt=""
        draggable={false}
        onError={(e) => {
          e.currentTarget.src = cards.back(kind, 'thumb');
        }}
      />
      <Counters card={card} />
    </button>
  );
}

function Counters({ card }: { card: CardInstance }) {
  const entries = Object.entries(card.counters).filter(([, n]) => n);
  if (entries.length === 0) return null;
  return (
    <span className="counters">
      {entries.map(([k, n]) => (
        <span key={k} className={`counter counter-${k}`} title={`${n} ${k}`}>
          {n}
        </span>
      ))}
    </span>
  );
}

function Stack(props: {
  seat: string;
  name: ZoneName;
  label: string;
  count: number;
  draggable?: boolean;
  onOpen?: () => void;
}) {
  const { send, seat: mySeat, judge } = useTable();
  const { begin } = useDrag();
  const cards = useCards();
  const own = props.seat === mySeat || judge;
  const deck = props.name === 'library' || props.name === 'crypt';
  const back =
    cards.state === 'ready'
      ? cards.back(props.name === 'crypt' ? 'crypt' : 'library', 'thumb')
      : undefined;
  return (
    <button
      type="button"
      className="stack"
      data-drop={`zone:${props.seat}:${props.name}`}
      disabled={!props.onOpen && !(deck && own)}
      title={
        deck && own
          ? `Click to draw, or drag to your ${props.name === 'crypt' ? 'uncontrolled region' : 'hand'}`
          : undefined
      }
      onPointerDown={
        deck && props.draggable
          ? (e) =>
              begin(
                e,
                { kind: 'deck', seat: props.seat, from: props.name as 'library' | 'crypt' },
                back,
              )
          : undefined
      }
      onClick={() => {
        if (props.onOpen) props.onOpen();
        else if (deck && own)
          send({ type: 'Draw', seat: props.seat, from: props.name as 'library' | 'crypt' });
      }}
    >
      <span>{props.label}</span>
      <strong>{props.count}</strong>
    </button>
  );
}

function Hand({ seat }: { seat: string }) {
  const { snapshot } = useTable();
  const ids = snapshot.view.zones[zoneId(seat, 'hand')] ?? [];
  return (
    <div className="hand zone" data-drop={`zone:${seat}:hand`}>
      <span className="zone-label">Hand ({ids.length})</span>
      <div className="zone-cards">
        {ids.map((id) => (
          <CardView key={id} id={id} />
        ))}
      </div>
    </div>
  );
}

function CardMenu(props: {
  card: CardInstance;
  anchor: DOMRect;
  onClose: () => void;
  onPick: (card: CardInstance) => void;
}) {
  const { seat, judge, send } = useTable();
  const cards = useCards();
  const ref = useRef<HTMLDivElement>(null);
  const items: MenuItem[] = cardActions(props.card, seat, judge);
  const name =
    props.card.cardId && cards.state === 'ready' ? cards.get(props.card.cardId)?.name : undefined;
  useEffect(() => {
    ref.current?.querySelector('button')?.focus();
    const close = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) props.onClose();
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [props]);
  const top = Math.min(props.anchor.bottom + 4, window.innerHeight - 320);
  const left = Math.min(props.anchor.left, window.innerWidth - 230);
  return (
    <div
      ref={ref}
      className="card-menu"
      role="menu"
      style={{ top: Math.max(8, top), left: Math.max(8, left) }}
    >
      <p className="muted small">{name ?? 'Hidden card'}</p>
      {items.length === 0 && <p className="muted small">Nothing you can do with this card.</p>}
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className={item.danger ? 'danger' : undefined}
          onClick={() => {
            if (item.command) send(item.command);
            if (item.pick) props.onPick(props.card);
            props.onClose();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

function Inspector({ card }: { card: CardInstance | undefined }) {
  const cards = useCards();
  if (!card || cards.state !== 'ready' || !card.cardId) return null;
  const record: CardRecord | undefined = cards.get(card.cardId);
  if (!record) return null;
  const counters = Object.entries(card.counters)
    .map(([k, n]) => `${n} ${k}`)
    .join(', ');
  return (
    <aside className="inspector" aria-live="polite">
      <img src={cards.image(record.id, 'full')} alt={record.name} />
      <div>
        <strong>{record.name}</strong>
        <p className="small muted">
          {[
            card.locked && 'locked',
            card.faceDown && 'face down',
            card.contested && 'contested',
            counters,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      </div>
    </aside>
  );
}

function ZoneDialog({ zone, onClose }: { zone: ZoneId; onClose: () => void }) {
  const { snapshot } = useTable();
  const ids = snapshot.view.zones[zone] ?? [];
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog ref={dialog} className="zone-dialog" onClose={onClose} aria-label="Zone contents">
      <div className="zone-cards">
        {ids.length === 0 && <p className="muted">Empty</p>}
        {ids.map((id) => (
          <CardView key={id} id={id} />
        ))}
      </div>
      <button type="button" onClick={() => dialog.current?.close()}>
        Close
      </button>
    </dialog>
  );
}

function TurnBar({ zoom, setZoom }: { zoom: number; setZoom: (z: number) => void }) {
  const { snapshot, client, seat, judge, send } = useTable();
  const view = snapshot.view;
  const turn = view.turn;
  const myTurn = turn?.seat === seat;
  return (
    <div className="turn-bar toolbar">
      <span>
        {turn
          ? `Turn ${turn.number} · ${client.seatName(turn.seat)} · ${turn.phase}`
          : 'Waiting to start'}
        {view.turnDirection === 'toPredator' && ' · play passes to the predator'}
      </span>
      {(myTurn || judge) && (
        <button type="button" className="primary" onClick={() => send({ type: 'AdvancePhase' })}>
          {turn?.phase === 'discard' ? 'End turn' : 'Next phase'}
        </button>
      )}
      {seat && (
        <>
          <button type="button" onClick={() => send({ type: 'Draw', seat })}>
            Draw
          </button>
          <button type="button" onClick={() => send({ type: 'Draw', seat, from: 'crypt' })}>
            Draw crypt
          </button>
          <button
            type="button"
            onClick={() => send({ type: 'Shuffle', zone: zoneId(seat, 'library') })}
          >
            Shuffle library
          </button>
          <button type="button" onClick={() => send({ type: 'SetEdge', seat })}>
            Take the Edge
          </button>
          <button
            type="button"
            onClick={() =>
              send({
                type: 'SetTurnDirection',
                direction: view.turnDirection === 'toPrey' ? 'toPredator' : 'toPrey',
              })
            }
          >
            Reverse play
          </button>
        </>
      )}
      <span className="zoom-controls">
        <button
          type="button"
          aria-label="Zoom out"
          onClick={() => setZoom(Math.max(0.5, zoom - 0.1))}
        >
          −
        </button>
        <span className="small">{Math.round(zoom * 100)}%</span>
        <button
          type="button"
          aria-label="Zoom in"
          onClick={() => setZoom(Math.min(1.8, zoom + 0.1))}
        >
          +
        </button>
      </span>
    </div>
  );
}

/** Ctrl/⌘ + wheel and two-finger pinch zoom (UX-05); scrolling pans. */
function ZoomViewport({
  zoom,
  setZoom,
  children,
}: {
  zoom: number;
  setZoom: (z: number) => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const latest = useRef(zoom);
  latest.current = zoom;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const clamp = (z: number) => Math.min(1.8, Math.max(0.5, z));
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setZoom(clamp(latest.current * Math.exp(-e.deltaY / 300)));
    };
    const pointers = new Map<number, { x: number; y: number }>();
    let startDist = 0;
    let startZoom = 1;
    const dist = () => {
      const [a, b] = [...pointers.values()];
      return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
    };
    const down = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        startDist = dist();
        startZoom = latest.current;
      }
    };
    const move = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2 && startDist > 0) setZoom(clamp((startZoom * dist()) / startDist));
    };
    const up = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) startDist = 0;
    };
    el.addEventListener('wheel', wheel, { passive: false });
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    return () => {
      el.removeEventListener('wheel', wheel);
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
  }, [setZoom]);
  return (
    <div ref={ref} className="table-viewport">
      <div className="table" style={{ zoom }}>
        {children}
      </div>
    </div>
  );
}
