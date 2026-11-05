/**
 * The action toolbar (UX-03) and decision prompts (UX-09). Shows what the table is waiting for,
 * and the offers the engine computes for this player. Choosing an offer walks its steps, with the
 * candidate cards highlighted on the table; anything that reveals information or affects other
 * players asks for confirmation first (GAME-11).
 */
import {
  type ActionKind,
  autoPassPhases,
  type CardCatalog,
  deadlines,
  type GameState,
  impulseHolder,
  isWaitingOn,
  type Offer,
  type OfferStep,
  type Override,
  PHASES,
  type StepValue,
  stopRules,
  type Wait,
  type WaitKind,
  waitingOn,
} from '@torn-signpost/engine';
import type { PlayerCommand } from '@torn-signpost/protocol';
import { useEffect } from 'react';
import { useConfig } from '../content.tsx';
import { setWaitingTitle } from '../title.ts';
import { Clock, formatLeft, useNow } from './Clock.tsx';
import type { TableClient } from './client.ts';

export interface Choosing {
  offer: Offer;
  values: StepValue[];
}

const VERBS: Record<ActionKind, string> = {
  bleed: 'bleeds',
  hunt: 'hunts',
  political: 'calls a political action',
  equip: 'equips',
  recruit: 'recruits an ally',
  employ: 'employs a retainer',
  other: 'takes an action',
};

/** The current step of an offer being chosen, or undefined once every step has a value. */
export function currentStep(c: Choosing | undefined): OfferStep | undefined {
  return c?.offer.steps[c.values.length];
}

/** What an action is called in a prompt ("block Julia Prima's bleed?"). */
const NOUNS: Record<ActionKind, string> = {
  bleed: 'bleed',
  hunt: 'hunt',
  political: 'political action',
  equip: 'equip action',
  recruit: 'recruit action',
  employ: 'employ action',
  other: 'action',
};

/** What everyone else is told the table waits for. */
const WAIT_LABELS: Record<Exclude<WaitKind, 'phase'>, string> = {
  impulse: 'impulse',
  block: 'block decision',
  resolve: 'resolving the action',
  combat: 'combat',
};

/**
 * The decision prompt (UX-09): the question for the player the table waits on, and for everyone
 * else who it waits on and why.
 */
export function promptFor(
  view: GameState,
  seat: string | undefined,
  waits: Wait[],
  who: (seat: string) => string,
  name: (id: string | undefined) => string,
): { mine: boolean; text: string } | undefined {
  const turn = view.turn;
  const first = waits[0];
  if (!turn || !first) return undefined;
  const a = view.action;
  const action = a ? `${name(a.minion)}'s ${NOUNS[a.kind]}` : 'the action';
  if (seat !== undefined && waits.some((w) => w.seat === seat)) {
    switch (first.kind) {
      case 'phase':
        return {
          mine: true,
          text:
            turn.phase === 'discard'
              ? 'Your discard phase: play cards, then end your turn'
              : `Your ${turn.phase} phase: act, then end the phase`,
        };
      case 'impulse':
        return {
          mine: true,
          text:
            view.window?.kind === 'blocks'
              ? `Play a card or pass (${action})`
              : `Play a card or pass (end of ${who(turn.seat)}'s ${turn.phase} phase)`,
        };
      case 'block':
        return { mine: true, text: `Block ${action}?` };
      case 'resolve':
        return { mine: true, text: `Resolve ${action}: did it succeed?` };
      case 'combat':
        return { mine: true, text: `Combat (${action}): end combat when it's over` };
    }
  }
  const names = waits.map((w) => who(w.seat));
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
  const why = first.kind === 'phase' ? `${turn.phase} phase` : WAIT_LABELS[first.kind];
  return { mine: false, text: `Waiting on ${list} (${why})` };
}

export function FlowBar(props: {
  view: GameState;
  seat: string | undefined;
  client: TableClient;
  catalog: CardCatalog;
  offers: Offer[];
  choosing: Choosing | undefined;
  setChoosing: (c: Choosing | undefined) => void;
  send: (command: PlayerCommand) => void;
  judge?: boolean;
}) {
  const { view, seat, client, catalog, offers, choosing, setChoosing, send } = props;
  const clock = !!useConfig().flags.clock;
  const now = useNow(60_000);
  const mine = isWaitingOn(view, seat);
  const name = (id: string | undefined) => {
    const cardId = id ? view.cards[id]?.cardId : undefined;
    if (!cardId) return 'a hidden card';
    return catalog.get(cardId)?.name ?? `an unknown card (${cardId})`;
  };
  const prompt = promptFor(view, seat, waitingOn(view), client.seatName, name);
  // An away player's time to decide (TEMPO-04), shown to everyone.
  const due = clock ? deadlines(view).find((d) => !d.expired) : undefined;
  const dueNote = due ? ` · ${formatLeft(Date.parse(due.dueAt) - now)} to decide` : '';
  const paused = !!view.pause;

  // Tell the player in the tab title when the table is waiting on them (UX-09).
  useEffect(() => {
    if (!mine) return;
    setWaitingTitle(true);
    return () => setWaitingTitle(false);
  }, [mine]);

  const start = (offer: Offer) => {
    if (offer.steps.length === 0 && !offer.confirm) send(offer.build([]));
    else setChoosing({ offer, values: [] });
  };
  const step = currentStep(choosing);
  const choose = (value: StepValue) => {
    if (!choosing) return;
    const values = [...choosing.values, value];
    const next = { offer: choosing.offer, values };
    if (values.length === choosing.offer.steps.length && !choosing.offer.confirm) {
      send(choosing.offer.build(values));
      setChoosing(undefined);
    } else setChoosing(next);
  };
  const describeValue = (s: OfferStep, v: StepValue) => {
    if (s.kind === 'card') return v === undefined ? 'no card' : name(v as string);
    if (s.kind === 'seat') return client.seatName(v as string);
    if (s.kind === 'toggle') return v ? s.label : '';
    return `${s.label}: ${v}`;
  };

  return (
    <section className={['flow-bar', mine ? 'yours' : ''].join(' ')} aria-label="Game flow">
      {/* Announced when it changes, without taking focus: the offers below stay where they are. */}
      <div className="flow-head">
        <p className="flow-prompt" aria-live="polite">
          {paused
            ? 'The game is paused'
            : prompt &&
              (prompt.mine ? (
                <strong>Your decision: {prompt.text}</strong>
              ) : (
                `${prompt.text}${dueNote}`
              ))}
        </p>
        {clock && (
          <Clock
            view={view}
            seat={seat}
            judge={!!props.judge}
            seatName={client.seatName}
            send={send}
          />
        )}
      </div>
      <p className="flow-status muted small">{statusLine(view, client, name)}</p>
      {choosing ? (
        <div className="flow-choose toolbar">
          <strong>{choosing.offer.label}</strong>
          {choosing.offer.explain && <span className="small">{choosing.offer.explain}</span>}
          {choosing.offer.steps.slice(0, choosing.values.length).map((s, i) => {
            const text = describeValue(s, choosing.values[i]);
            return text ? (
              <span key={s.label} className="badge">
                {text}
              </span>
            ) : null;
          })}
          {step ? (
            <StepInput step={step} name={name} seatName={client.seatName} onChoose={choose} />
          ) : (
            <button
              type="button"
              className="primary"
              onClick={() => {
                send(choosing.offer.build(choosing.values));
                setChoosing(undefined);
              }}
            >
              Confirm
            </button>
          )}
          <button type="button" onClick={() => setChoosing(undefined)}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="flow-offers toolbar">
          {(paused ? [] : offers).map((o) => (
            <button
              key={o.id}
              type="button"
              className={o.primary ? 'primary' : undefined}
              onClick={() => start(o)}
            >
              {o.label}
            </button>
          ))}
          {seat && <AutoPass view={view} seat={seat} send={send} />}
        </div>
      )}
    </section>
  );
}

function StepInput(props: {
  step: OfferStep;
  name: (id: string) => string;
  seatName: (seat: string) => string;
  onChoose: (value: StepValue) => void;
}) {
  const { step, onChoose } = props;
  switch (step.kind) {
    case 'card':
      // Cards are chosen on the table (highlighted); the list helps on small screens and for
      // keyboard and screen-reader users.
      return (
        <>
          <span className="muted small">{step.label}:</span>
          {step.candidates.map((id) => (
            <button key={id} type="button" onClick={() => onChoose(id)}>
              {props.name(id)}
            </button>
          ))}
          {step.optional && (
            <button type="button" onClick={() => onChoose(undefined)}>
              None
            </button>
          )}
        </>
      );
    case 'seat':
      return (
        <>
          <span className="muted small">{step.label}</span>
          {step.candidates.map((s) => (
            <button
              key={s}
              type="button"
              className={s === step.default ? 'primary' : undefined}
              onClick={() => onChoose(s)}
            >
              {props.seatName(s)}
            </button>
          ))}
        </>
      );
    case 'amount':
      return (
        <form
          className="toolbar"
          onSubmit={(e) => {
            e.preventDefault();
            const n = Number(new FormData(e.currentTarget).get('amount'));
            onChoose(Number.isInteger(n) && n >= step.min ? n : step.default);
          }}
        >
          <label className="small">
            {step.label}{' '}
            <input
              name="amount"
              type="number"
              min={step.min}
              defaultValue={step.default}
              size={3}
            />
          </label>
          <button type="submit">OK</button>
        </form>
      );
    case 'toggle':
      return (
        <>
          <button type="button" className="primary" onClick={() => onChoose(true)}>
            {step.label}
          </button>
          <button type="button" onClick={() => onChoose(false)}>
            No
          </button>
        </>
      );
  }
}

const STOP_CHOICES = [
  ['never', 'Only when I can block'],
  ['neighbours', 'For my prey’s and predator’s actions'],
  ['anyone', 'For every action'],
] as const;

/**
 * Which end-of-phase pass rounds to pass automatically (all of them by default), and the standing
 * stops for block windows.
 */
function AutoPass(props: {
  view: GameState;
  seat: string;
  send: (command: PlayerCommand) => void;
}) {
  const me = props.view.seats.find((s) => s.id === props.seat);
  if (!me) return null;
  const phases = autoPassPhases(me);
  const stops = stopRules(me);
  const blockStop = stops.find((r) => r.on === 'block-window')?.actors ?? 'never';
  return (
    <details className="autopass">
      <summary>Auto-pass</summary>
      <div className="autopass-menu">
        <p className="muted small">
          Pass automatically when other players end these phases. Turn one off to get a chance to
          play cards then.
        </p>
        {PHASES.map((p) => (
          <label key={p}>
            <input
              type="checkbox"
              checked={phases.includes(p)}
              onChange={(e) =>
                props.send({
                  type: 'SetAutoPass',
                  phases: e.target.checked
                    ? PHASES.filter((x) => x === p || phases.includes(x))
                    : phases.filter((x) => x !== p),
                })
              }
            />{' '}
            {p}
          </label>
        ))}
        <p className="muted small">
          Stop in block windows, even when you can't block, so you can play reactions that let you
          block anyway. Use Hold for a one-off stop.
        </p>
        {STOP_CHOICES.map(([value, label]) => (
          <label key={value}>
            <input
              type="radio"
              name="block-stop"
              checked={blockStop === value}
              onChange={() =>
                props.send({
                  type: 'SetStops',
                  stops: [
                    ...stops.filter((r) => r.on !== 'block-window'),
                    ...(value === 'never' ? [] : [{ on: 'block-window' as const, actors: value }]),
                  ],
                })
              }
            />{' '}
            {label}
          </label>
        ))}
      </div>
    </details>
  );
}

/** " (card effect: X, unverified)" for an override, so everyone sees it before responding. */
function overrideNote(
  o: Override | undefined,
  name: (id: string | undefined) => string,
  action?: string,
): string {
  if (!o) return '';
  // The action card is named already; other sources are in play or were just played, so visible.
  const source =
    o.source === undefined
      ? 'no card named'
      : o.source === action
        ? 'the action card'
        : name(o.source);
  return ` (card effect: ${source}${o.verified ? '' : ', unverified'})`;
}

function statusLine(
  view: GameState,
  client: TableClient,
  name: (id: string | undefined) => string,
): string {
  const turn = view.turn;
  if (!turn) return 'Waiting to start';
  const who = client.seatName;
  const holder = impulseHolder(view);
  const holds = view.window?.holds?.filter((s) => s !== holder) ?? [];
  const holding = holds.length ? ` · ${holds.map(who).join(', ')} asked to wait` : '';
  const a = view.action;
  if (a) {
    const target = a.target
      ? a.kind === 'bleed'
        ? ` ${who(a.target)}`
        : ` against ${who(a.target)}`
      : '';
    const card = a.cardId ? ` with ${name(a.card)}` : '';
    const what = `${name(a.minion)} ${VERBS[a.kind]}${target}${card}${overrideNote(a.override, name, a.card)}`;
    if (a.stage === 'combat') return `${what} · blocked by ${name(a.blocker)}: combat`;
    if (a.stage === 'resolution') return `${what} · not blocked: ${who(a.seat)} resolves it`;
    const attempt = a.blockAttempt
      ? ` · ${name(a.blockAttempt.minion)} tries to block${overrideNote(a.blockAttempt.override, name)}`
      : '';
    return `${what}${attempt}${holding}`;
  }
  if (view.window) {
    return `End of ${who(turn.seat)}'s ${turn.phase} phase${holding}`;
  }
  const reversed = view.turnDirection === 'toPredator' ? ' · play passes to the predator' : '';
  return `Turn ${turn.number} · ${who(turn.seat)} · ${turn.phase} phase${reversed}`;
}
