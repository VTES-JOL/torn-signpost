/**
 * The tabletop: seats in physical order around your own region, cards you can click for actions,
 * drag between zones or onto minions, zoom and inspect (UX-01/02/05/06), with the action toolbar
 * on top (UX-03).
 */
import type { CardRecord } from '@torn-signpost/cards';
import {
  availableActions,
  type CardCatalog,
  type CardInstance,
  type GameState,
  parseZoneId,
  predator,
  prey,
  tempo,
  type ZoneId,
  type ZoneName,
  zoneId,
} from '@torn-signpost/engine';
import type { PlayerCommand } from '@torn-signpost/protocol';
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ApiError } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { useCards, useConfig } from '../content.tsx';
import { useNarrow } from '../narrow.ts';
import { cardActions, type MenuItem } from './actions.ts';
import type { GameSnapshot, TableClient } from './client.ts';
import { DragProvider, type DragSource, type DropTarget, useDrag } from './drag.tsx';
import { type Choosing, currentStep, FlowBar } from './FlowBar.tsx';
import { canProposeEnd, EndGameControls, GameOver } from './GameEnd.tsx';
import { canCallJudge, JudgeCalls } from './JudgeCalls.tsx';
import { seatLayout } from './seatLayout.ts';

interface TableContextValue {
  snapshot: GameSnapshot;
  client: TableClient;
  seat: string | undefined;
  judge: boolean;
  /** A live game: presence, the clock, judge calls and ending by agreement; not a replay. */
  live: boolean;
  send(command: PlayerCommand): void;
  openMenu(card: CardInstance, anchor: DOMRect): void;
  /** Show a card large, beside where it is on screen (`anchor`). */
  inspect(card: CardInstance | undefined, anchor?: DOMRect): void;
  picking: CardInstance | undefined;
  pick(host: CardInstance): void;
  showZone(zone: ZoneId): void;
  /** Cards that answer the current toolbar step, if it asks for a card. */
  candidates: ReadonlySet<string> | undefined;
  choose(id: string): void;
  /** The minions in the current action or combat, and what they're doing in it. */
  roles: ReadonlyMap<string, Role>;
}

type Role = 'acting' | 'blocking' | 'combat' | 'target';

const ROLE_LABELS: Record<Role, string> = {
  acting: 'Acting',
  blocking: 'Blocking',
  combat: 'In combat',
  target: 'Target',
};

/**
 * Who's doing what, so the table shows it as well as the flow bar: the acting minion, a blocker
 * trying or blocking, both fighters in a combat, and the vampire a rescue or diablerie is aimed at.
 */
function minionRoles(view: GameState): Map<string, Role> {
  const roles = new Map<string, Role>();
  const a = view.action;
  if (!a) return roles;
  if (a.vampire) roles.set(a.vampire, 'target');
  if (a.combat) {
    roles.set(a.combat.acting, 'combat');
    roles.set(a.combat.opposing, 'combat');
    return roles;
  }
  if (a.blocker) roles.set(a.blocker, 'blocking');
  else if (a.blockAttempt) roles.set(a.blockAttempt.minion, 'blocking');
  roles.set(a.minion, 'acting');
  return roles;
}

const TableContext = createContext<TableContextValue | undefined>(undefined);
const useTable = () => {
  const t = useContext(TableContext);
  if (!t) throw new Error('useTable outside Table');
  return t;
};

const IN_PLAY: ZoneName[] = ['ready', 'torpor'];

export function Table(props: {
  client: TableClient;
  snapshot: GameSnapshot;
  catalog: CardCatalog;
  judge: boolean;
  onError: (m: string) => void;
  /** False for a replay: no presence, clock, judge calls or ending by agreement. */
  live?: boolean;
}) {
  const { client, snapshot, catalog, onError } = props;
  const live = props.live ?? true;
  const view = snapshot.view;
  // Nobody acts on a finished table, judges included (docs/m6-plan.md M6.6).
  const judge = props.judge && view.status !== 'finished';
  const judgeCalls = !!useConfig().flags.judgeCalls;
  const { user } = useAuth();
  // An ousted (or withdrawn) player only watches from now on, like a spectator; so does everyone
  // once the game is over (docs/m6-plan.md M6.6).
  const outOfGame = !!snapshot.seat && isOut(view, snapshot.seat);
  const seat = outOfGame || view.status === 'finished' ? undefined : snapshot.seat;
  const [menu, setMenu] = useState<{ card: CardInstance; anchor: DOMRect }>();
  const [inspected, setInspected] = useState<{ card: CardInstance; anchor?: DOMRect }>();
  const [picking, setPicking] = useState<CardInstance>();
  const [zoneDialog, setZoneDialog] = useState<ZoneId>();
  const [zoom, setZoom] = useState(1);
  const [choosing, setChoosing] = useState<Choosing>();
  // On a phone the table's tools fold behind one button (styles.css, max-width 760px).
  const [toolsOpen, setToolsOpen] = useState(false);
  // Opened from the ⋯ menu: the "Call a judge" form, and an admin confirming the end.
  const [calling, setCalling] = useState(false);
  const [confirmingEnd, setConfirmingEnd] = useState(false);
  const admin = !!user?.groups.includes('admin');
  const offers = useMemo(
    () => (seat ? availableActions(view, seat, catalog) : []),
    [view, seat, catalog],
  );
  // Drop a half-made choice when the game moves on and its offer is gone.
  const offerIds = offers.map((o) => o.id).join();
  useEffect(() => {
    setChoosing((c) => (c && offerIds.split(',').includes(c.offer.id) ? c : undefined));
  }, [offerIds]);
  const roles = useMemo(() => minionRoles(view), [view]);
  const step = currentStep(choosing);
  const candidates = step?.kind === 'card' ? new Set(step.candidates) : undefined;

  const send = (command: PlayerCommand) => {
    client.send(command).catch((e) => onError(e instanceof ApiError ? e.message : String(e)));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPicking(undefined);
        setMenu(undefined);
        setChoosing(undefined);
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
    live,
    send,
    openMenu: (card, anchor) => setMenu({ card, anchor }),
    inspect: (card, anchor) =>
      setInspected(card ? { card, ...(anchor ? { anchor } : {}) } : undefined),
    picking,
    pick: (host) => {
      if (picking && host.id !== picking.id)
        send({ type: 'Attach', card: picking.id, to: host.id });
      setPicking(undefined);
    },
    showZone: setZoneDialog,
    candidates,
    roles,
    choose: (id) => {
      if (!choosing || !candidates?.has(id)) return;
      const values = [...choosing.values, id];
      if (values.length === choosing.offer.steps.length && !choosing.offer.confirm) {
        send(choosing.offer.build(values));
        setChoosing(undefined);
      } else setChoosing({ offer: choosing.offer, values });
    },
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
        <GameOver view={view} seatName={client.seatName} />
        <FlowBar
          view={view}
          seat={seat}
          client={client}
          catalog={catalog}
          offers={offers}
          choosing={choosing}
          setChoosing={setChoosing}
          send={send}
          judge={judge}
          live={live}
        />
        {/* One row: the table tools, then judge calls and ending the game, then zoom. */}
        <div className={toolsOpen ? 'table-controls open' : 'table-controls'}>
          <button
            type="button"
            className="tools-toggle"
            aria-expanded={toolsOpen}
            onClick={() => setToolsOpen((v) => !v)}
          >
            {toolsOpen ? 'Hide table tools' : 'Table tools'}
          </button>
          <TurnBar zoom={zoom} setZoom={setZoom} />
          <MoreMenu
            items={[
              seat &&
                !view.pause && {
                  label: 'Reverse play',
                  run: () =>
                    send({
                      type: 'SetTurnDirection',
                      direction: view.turnDirection === 'toPrey' ? 'toPredator' : 'toPrey',
                    }),
                },
              live &&
                judgeCalls &&
                canCallJudge(view, seat) &&
                !calling && { label: 'Call a judge', run: () => setCalling(true) },
              live &&
                canProposeEnd(view, seat) && {
                  label: 'Propose ending the game',
                  run: () => send({ type: 'ProposeEnd' }),
                },
              live &&
                admin &&
                view.status === 'active' &&
                !confirmingEnd && { label: 'End the game…', run: () => setConfirmingEnd(true) },
            ]}
          />
          {live && judgeCalls && (
            <JudgeCalls
              view={view}
              seat={seat}
              judge={judge}
              user={user?.sub}
              seatName={client.seatName}
              send={send}
              calling={calling}
              setCalling={setCalling}
            />
          )}
          {live && (
            <EndGameControls
              view={view}
              seat={seat}
              admin={admin}
              seatName={client.seatName}
              send={send}
              confirming={confirmingEnd}
              setConfirming={setConfirmingEnd}
            />
          )}
        </div>
        {outOfGame && view.status === 'active' && (
          <p className="notice small" role="status">
            {view.seats.find((x) => x.id === snapshot.seat)?.withdrawn
              ? 'You withdrew from the game.'
              : 'You have been ousted.'}{' '}
            You can keep watching the game.
          </p>
        )}
        {picking && (
          <p className="picking" role="status">
            Choose a minion to attach to, or press Escape.
          </p>
        )}
        <div className={['table-area', candidates ? 'choosing' : ''].join(' ')}>
          <ZoomViewport zoom={zoom} setZoom={setZoom}>
            <Seats view={view} />
          </ZoomViewport>
          {seat && <Hand seat={seat} />}
        </div>
        {menu && (
          <CardMenu
            card={menu.card}
            anchor={menu.anchor}
            onClose={() => setMenu(undefined)}
            onPick={(card) => setPicking(card)}
          />
        )}
        <Inspector card={inspected?.card} anchor={inspected?.anchor} />
        {zoneDialog && <ZoneDialog zone={zoneDialog} onClose={() => setZoneDialog(undefined)} />}
      </DragProvider>
    </TableContext.Provider>
  );
}

/** Opponents placed as at a real table (prey left, predator right, the rest across); you below. */
function Seats({ view }: { view: GameState }) {
  const { seat, client } = useTable();
  const refs = view.seats.map((s) => ({ id: s.id, ousted: isOut(view, s.id) }));
  // Ousted and withdrawn Methuselahs leave the table; the rest close up around it.
  const me = seat ?? view.seats.find((s) => !isOut(view, s.id))?.id;
  const order: string[] = [];
  if (me) {
    const i = view.seats.findIndex((s) => s.id === me);
    for (let n = 1; n < view.seats.length; n++) {
      const id = view.seats[(i + n) % view.seats.length]?.id;
      if (id && !isOut(view, id)) order.push(id);
    }
  }
  const preyOf = me ? prey(refs, me) : undefined;
  const predOf = me ? predator(refs, me) : undefined;
  const layout = seatLayout(order, preyOf, predOf);
  // Prey and predator are yours only when you're playing; otherwise they'd be someone else's.
  const relation = (id: string) =>
    !seat ? undefined : id === preyOf ? 'prey' : id === predOf ? 'predator' : undefined;
  return (
    <div className="seats">
      <div
        className="opponents"
        style={{ gridTemplateColumns: `repeat(${layout.columns}, minmax(0, 1fr))` }}
      >
        {layout.placements.map(({ seat: id, row, column }) => (
          <SeatArea
            key={id}
            seat={id}
            place={{ gridRow: row, gridColumn: column }}
            label={relation(id)}
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
  place,
}: {
  seat: string;
  own?: boolean;
  label?: string | undefined;
  /** Grid cell among the opponents. */
  place?: { gridRow: number; gridColumn: number };
}) {
  const { snapshot, client, send, judge, live, showZone, candidates, roles } = useTable();
  const { begin } = useDrag();
  const presence = !!useConfig().flags.presence && live;
  // On a phone an opponent's seat folds to one line until you open it; it opens by itself when
  // the step you're on asks for one of its cards.
  const [opened, setOpened] = useState(false);
  const view = snapshot.view;
  const s = view.seats.find((x) => x.id === seat);
  if (!s) return null;
  const count = (z: ZoneName) => view.zones[zoneId(seat, z)]?.length ?? 0;
  const turn = view.turn?.seat === seat;
  const canAct = own || judge;
  // Open too while one of its minions is in the action or the combat.
  const wanted = (['ready', 'torpor', 'uncontrolled'] as const).some((z) =>
    view.zones[zoneId(seat, z)]?.some((id) => candidates?.has(id) || roles.has(id)),
  );
  const folded = !own && !opened && !wanted;
  const name = client.seatName(seat);
  return (
    <section
      className={[
        'seat',
        own ? 'own' : '',
        turn ? 'turn' : '',
        s.ousted ? 'ousted' : '',
        folded ? 'folded' : '',
      ].join(' ')}
      aria-label={`Seat ${seat}: ${client.seatName(seat)}`}
      style={place}
    >
      <header className="seat-header">
        {presence && !s.ousted && <PresenceDot present={!!s.present} />}
        <strong>{name}</strong>
        {label && <span className="muted small">{label}</span>}
        {turn && <span className="badge attention">{view.turn?.phase}</span>}
        {s.hasEdge && <span className="badge ok">Edge</span>}
        {s.withdrawing && (
          <span
            className="badge warning"
            title="Leaves the game at the start of their next turn, unless they lose or spend pool or blood, or a minion of theirs enters combat"
          >
            withdrawing
          </span>
        )}
        <span
          className="pool"
          data-drop={`pool:${seat}`}
          onPointerDown={canAct ? (e) => begin(e, { kind: 'pool', seat }) : undefined}
          title={canAct ? 'Drag onto a vampire to transfer 1 blood' : undefined}
        >
          Pool {s.pool}
        </span>
        {view.status === 'active' && (
          <>
            <button
              type="button"
              className="pool-step"
              aria-label={`Lower ${client.seatName(seat)}'s pool`}
              onClick={() => send({ type: 'AdjustPool', seat, delta: -1 })}
            >
              −
            </button>
            <button
              type="button"
              className="pool-step"
              aria-label={`Raise ${client.seatName(seat)}'s pool`}
              onClick={() => send({ type: 'AdjustPool', seat, delta: 1 })}
            >
              +
            </button>
          </>
        )}
        <span>VP {s.vp}</span>
        {!own && (
          <button
            type="button"
            className="seat-toggle"
            aria-expanded={!folded}
            aria-label={folded ? `Show ${name}'s cards` : `Hide ${name}'s cards`}
            disabled={wanted}
            onClick={() => setOpened((v) => !v)}
          >
            {folded ? '▸' : '▾'}
          </button>
        )}
      </header>
      {!own && (
        <p className="seat-summary">
          {count('ready')} ready · {count('torpor')} in torpor · {count('hand')} in hand ·{' '}
          {count('library')} in library
        </p>
      )}
      <div className="seat-zones">
        <Zone seat={seat} name="ready" label="Ready" />
        <Zone seat={seat} name="torpor" label="Torpor" />
        {/* An opponent's face-down cards say nothing but how many: one pile, not a row of backs. */}
        <Zone seat={seat} name="uncontrolled" label="Uncontrolled" pile={!own} />
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

function Zone({
  seat,
  name,
  label,
  pile,
}: {
  seat: string;
  name: ZoneName;
  label: string;
  /** Show the zone as one pile with a count while none of its cards are known to the viewer. */
  pile?: boolean;
}) {
  const { snapshot } = useTable();
  const cards = useCards();
  const view = snapshot.view;
  const ids = view.zones[zoneId(seat, name)] ?? [];
  if (
    pile &&
    ids.length > 0 &&
    cards.state === 'ready' &&
    ids.every((id) => !view.cards[id]?.cardId)
  ) {
    return (
      <div className={`zone zone-${name} zone-pile`} data-drop={`zone:${seat}:${name}`}>
        <span className="zone-label">{label}</span>
        <span
          className="pile"
          title={`${ids.length} face-down ${ids.length === 1 ? 'card' : 'cards'}`}
        >
          <img src={cards.back('crypt', 'thumb')} alt="" draggable={false} />
          <span className="pile-count">
            {ids.length}
            <span className="sr-only"> face-down {ids.length === 1 ? 'card' : 'cards'}</span>
          </span>
        </span>
      </div>
    );
  }
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
  // Everything in the stack, including cards attached to attached cards (older games could
  // nest them; the engine now attaches to the host), so nothing goes missing.
  const cards = Object.values(snapshot.view.cards);
  const children: CardInstance[] = [];
  const collect = (host: string) => {
    for (const c of cards) {
      if (c.attachedTo !== host || children.includes(c)) continue;
      children.push(c);
      collect(c.id);
    }
  };
  collect(id);
  return (
    // The host comes first on screen (CSS order), with its attached cards fanned out to its right.
    <div className="card-stack">
      {children.map((c, i) => (
        // Behind the host, the first attachment over the next, each showing its right side.
        <div key={c.id} className="attached" style={{ zIndex: -1 - i }}>
          <CardView id={c.id} />
        </div>
      ))}
      <div className="host">
        <CardView id={id} />
      </div>
    </div>
  );
}

function CardView({ id }: { id: string }) {
  const { snapshot, openMenu, inspect, picking, pick, seat, judge, candidates, choose, roles } =
    useTable();
  const cards = useCards();
  const { begin } = useDrag();
  const card = snapshot.view.cards[id];
  const hold = useRef<ReturnType<typeof setTimeout>>(undefined);
  if (!card || cards.state !== 'ready') return null;
  const record = card.cardId ? cards.get(card.cardId) : undefined;
  // The viewer knows the card, but the card data doesn't: say so rather than show a card back.
  const unknown = card.cardId !== undefined && !record;
  const zone = parseZoneId(card.zone);
  const kind =
    record?.kind ?? (zone.name === 'crypt' || zone.name === 'uncontrolled' ? 'crypt' : 'library');
  const src = record ? cards.image(record.id, 'thumb') : cards.back(kind, 'thumb');
  const canDrag = judge || zone.seat === seat || card.controller === seat;
  const role = roles.get(card.id);
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
        candidates?.has(card.id) ? 'candidate' : '',
        unknown ? 'unknown' : '',
        role ? `role-${role}` : '',
      ].join(' ')}
      style={{ viewTransitionName: `c-${card.id}` }}
      data-drop={`card:${card.id}`}
      data-role={role && ROLE_LABELS[role]}
      aria-label={[
        cardLabel(card.cardId, record),
        card.locked && 'locked',
        role && ROLE_LABELS[role].toLowerCase(),
      ]
        .filter(Boolean)
        .join(', ')}
      onClick={(e) => {
        if (candidates) choose(card.id);
        else if (picking) pick(card);
        else openMenu(card, e.currentTarget.getBoundingClientRect());
      }}
      onPointerDown={(e) => {
        if (e.pointerType === 'touch') hold.current = setTimeout(() => inspect(card), 450);
        if (canDrag) begin(e, { kind: 'card', id: card.id, zone: card.zone }, src);
      }}
      onPointerUp={() => clearTimeout(hold.current)}
      onPointerEnter={(e) => {
        if (e.pointerType === 'mouse') {
          const anchor = e.currentTarget.getBoundingClientRect();
          hold.current = setTimeout(() => inspect(card, anchor), 350);
        }
      }}
      onPointerLeave={clear}
      onContextMenu={(e) => {
        e.preventDefault();
        openMenu(card, e.currentTarget.getBoundingClientRect());
      }}
    >
      {unknown ? (
        <span className="card-unknown" title={cardLabel(card.cardId, record)}>
          Unknown card
          <code>{card.cardId}</code>
        </span>
      ) : (
        <img
          src={src}
          alt=""
          draggable={false}
          onError={(e) => {
            e.currentTarget.src = cards.back(kind, 'thumb');
          }}
        />
      )}
      <Counters card={card} />
    </button>
  );
}

/**
 * A card's label: its name; "Unknown card <id>" when the viewer knows it but the card data
 * doesn't; "Hidden card" when the viewer can't see it.
 */
function cardLabel(cardId: string | undefined, record: { name: string } | undefined): string {
  if (record) return record.name;
  return cardId ? `Unknown card ${cardId}` : 'Hidden card';
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
  // On a phone the hand is a sheet: one row of cards, or opened up, larger and wrapped.
  const [open, setOpen] = useState(false);
  const ids = snapshot.view.zones[zoneId(seat, 'hand')] ?? [];
  return (
    <div className={open ? 'hand zone open' : 'hand zone'} data-drop={`zone:${seat}:hand`}>
      <span className="zone-label">Hand ({ids.length})</span>
      <button
        type="button"
        className="hand-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? 'Hand ▾ smaller' : 'Hand ▴ larger'}
      </button>
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
  const cardId = props.card.cardId;
  const name = cardLabel(cardId, cardId && cards.state === 'ready' ? cards.get(cardId) : undefined);
  // On a phone it's a sheet at the bottom with the card large: there's no hover to inspect it.
  const sheet = useNarrow();
  useEffect(() => {
    // Focus without scrolling: the menu is fixed, the page shouldn't move under it.
    ref.current?.querySelector('button')?.focus({ preventScroll: true });
    const close = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) props.onClose();
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [props]);
  const top = Math.min(props.anchor.bottom + 4, window.innerHeight - 380);
  const left = Math.min(props.anchor.left, window.innerWidth - 230);
  return (
    <div
      ref={ref}
      className={sheet ? 'card-menu sheet' : 'card-menu'}
      role="menu"
      style={sheet ? undefined : { top: Math.max(8, top), left: Math.max(8, left) }}
    >
      {/* Which card this is: a small image as well as the name, before you play it. */}
      <div className="card-menu-head">
        {cards.state === 'ready' && cardId && cards.get(cardId) && (
          <img src={cards.image(cardId, sheet ? 'full' : 'thumb')} alt="" />
        )}
        <p className="muted small">{name}</p>
      </div>
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

/** The preview's size (styles.css, .inspector): 15rem wide, the card plus a line or two. */
const PREVIEW = { width: 240, height: 390, gap: 12 };

/**
 * Beside the card: to its right, or to its left if there's no room, level with it as far as the
 * window allows. Without an anchor (a phone's press and hold), where styles.css puts it.
 */
function previewPlace(anchor: DOMRect | undefined, narrow: boolean) {
  if (!anchor || narrow) return undefined;
  const right = anchor.right + PREVIEW.gap;
  const left =
    right + PREVIEW.width <= window.innerWidth
      ? right
      : Math.max(8, anchor.left - PREVIEW.gap - PREVIEW.width);
  const middle = anchor.top + anchor.height / 2 - PREVIEW.height / 2;
  const top = Math.max(8, Math.min(middle, window.innerHeight - PREVIEW.height - 8));
  return { left, top, right: 'auto' };
}

function Inspector({
  card,
  anchor,
}: {
  card: CardInstance | undefined;
  anchor?: DOMRect | undefined;
}) {
  const cards = useCards();
  const style = previewPlace(anchor, useNarrow());
  if (!card || cards.state !== 'ready' || !card.cardId) return null;
  const record: CardRecord | undefined = cards.get(card.cardId);
  if (!record) {
    return (
      <aside className="inspector" aria-live="polite" style={style}>
        <div>
          <strong>{cardLabel(card.cardId, record)}</strong>
          <p className="small muted">This card isn't in the card data, so it can't be shown.</p>
        </div>
      </aside>
    );
  }
  const counters = Object.entries(card.counters)
    .map(([k, n]) => `${n} ${k}`)
    .join(', ');
  const state = [
    card.locked && 'locked',
    card.faceDown && 'face down',
    card.contested && 'contested',
    counters,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <aside className="inspector" aria-live="polite" style={style}>
      <img src={cards.image(record.id, 'full')} alt={record.name} />
      <div>
        <strong>{record.name}</strong>
        {state && <p className="small muted">{state}</p>}
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
  const { snapshot, seat, judge, live, send } = useTable();
  const view = snapshot.view;
  const presence = !!useConfig().flags.presence && live;
  return (
    <div className="turn-bar toolbar">
      {judge && !seat && (
        <button type="button" onClick={() => send({ type: 'AdvancePhase' })}>
          Next phase (judge)
        </button>
      )}
      {seat && !view.pause && (
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
        </>
      )}
      {presence && <PresenceStatus />}
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

/**
 * The table's rarer and weightier tools behind one ⋯ button, out of the way of the everyday ones:
 * reversing play, calling a judge, proposing to end the game, an admin ending it.
 */
function MoreMenu({
  items,
}: {
  items: (false | '' | undefined | { label: string; run: () => void })[];
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const shown = items.filter((i): i is { label: string; run: () => void } => !!i);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', key);
    };
  }, [open]);
  if (shown.length === 0) return null;
  return (
    <div ref={ref} className="more-menu">
      <button
        type="button"
        aria-label="More table tools"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
      >
        ⋯
      </button>
      {open && (
        <div className="more-menu-panel" role="menu">
          {shown.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                item.run();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
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

/** Ousted or withdrawn: no longer at the table. */
/** At the table or away (TEMPO-06). Colour is never the only signal: the label says it too. */
function PresenceDot({ present }: { present: boolean }) {
  const label = present ? 'At the table' : 'Away';
  return (
    <span
      className={`presence-dot ${present ? 'on' : 'off'}`}
      role="img"
      aria-label={label}
      title={label}
    />
  );
}

/** Live or async, who is away, and how many are watching. */
function PresenceStatus() {
  const { snapshot, client } = useTable();
  const view = snapshot.view;
  if (view.status !== 'active') return null;
  const away = view.seats.filter((s) => !isOut(view, s.id) && !s.present);
  const names = away.map((s) => client.seatName(s.id));
  const n = snapshot.spectators ?? 0;
  return (
    <span className="presence-status small" role="status">
      <span className={`badge ${tempo(view) === 'live' ? 'ok' : ''}`}>
        {tempo(view) === 'live' ? 'Live' : 'Async'}
      </span>
      {/* Each seat's dot says who; here, just how many, with their names on hover. */}
      {names.length > 0 && (
        <span
          className="muted"
          title={
            names.length === 1
              ? `${names[0]} is away`
              : `${names.slice(0, -1).join(', ')} and ${names.at(-1)} are away`
          }
        >
          {names.length === 1 ? `${names[0]} is away` : `${names.length} away`}
        </span>
      )}
      {n > 0 && <span className="muted">{n === 1 ? '1 watching' : `${n} watching`}</span>}
    </span>
  );
}

function isOut(view: GameState, seat: string): boolean {
  const s = view.seats.find((x) => x.id === seat);
  return !!(s?.ousted || s?.withdrawn);
}
