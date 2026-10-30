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
  type GameState,
  impulseHolder,
  type Offer,
  type OfferStep,
  PHASES,
  type StepValue,
} from '@torn-signpost/engine';
import type { PlayerCommand } from '@torn-signpost/protocol';
import { useEffect } from 'react';
import type { GameClient } from './client.ts';

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

/** Whether the table is waiting on this player. */
export function waitingOnMe(view: GameState, seat: string | undefined): boolean {
  if (!seat) return false;
  if (view.window) return impulseHolder(view) === seat;
  const a = view.action;
  if (a?.stage === 'resolution') return a.seat === seat;
  if (a?.stage === 'combat') {
    return a.seat === seat || view.cards[a.blocker ?? '']?.controller === seat;
  }
  return false;
}

export function FlowBar(props: {
  view: GameState;
  seat: string | undefined;
  client: GameClient;
  catalog: CardCatalog;
  offers: Offer[];
  choosing: Choosing | undefined;
  setChoosing: (c: Choosing | undefined) => void;
  send: (command: PlayerCommand) => void;
}) {
  const { view, seat, client, catalog, offers, choosing, setChoosing, send } = props;
  const mine = waitingOnMe(view, seat);
  const name = (id: string | undefined) => {
    const cardId = id ? view.cards[id]?.cardId : undefined;
    return (cardId && catalog.get(cardId)?.name) || 'a hidden card';
  };

  // Tell the player in the tab title when the table is waiting on them (UX-09).
  useEffect(() => {
    if (!mine) return;
    const title = document.title;
    document.title = `● ${title}`;
    return () => {
      document.title = title;
    };
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
      <p className="flow-status" aria-live="polite">
        {mine && <strong>Your move · </strong>}
        {statusLine(view, client, name)}
      </p>
      {choosing ? (
        <div className="flow-choose toolbar">
          <strong>{choosing.offer.label}</strong>
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
          {offers.map((o) => (
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

/** Which end-of-phase pass rounds to pass automatically (all of them by default). */
function AutoPass(props: {
  view: GameState;
  seat: string;
  send: (command: PlayerCommand) => void;
}) {
  const me = props.view.seats.find((s) => s.id === props.seat);
  if (!me) return null;
  const phases = autoPassPhases(me);
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
      </div>
    </details>
  );
}

function statusLine(
  view: GameState,
  client: GameClient,
  name: (id: string | undefined) => string,
): string {
  const turn = view.turn;
  if (!turn) return 'Waiting to start';
  const who = client.seatName;
  const holder = impulseHolder(view);
  const a = view.action;
  if (a) {
    const target = a.target
      ? a.kind === 'bleed'
        ? ` ${who(a.target)}`
        : ` against ${who(a.target)}`
      : '';
    const card = a.cardId ? ` with ${name(a.card)}` : '';
    const what = `${name(a.minion)} ${VERBS[a.kind]}${target}${card}`;
    if (a.stage === 'combat') return `${what} · blocked by ${name(a.blocker)}: combat`;
    if (a.stage === 'resolution') return `${what} · not blocked: ${who(a.seat)} resolves it`;
    const attempt = a.blockAttempt ? ` · ${name(a.blockAttempt.minion)} tries to block` : '';
    return `${what}${attempt} · waiting for ${holder ? who(holder) : 'nobody'}`;
  }
  if (view.window) {
    return `End of ${who(turn.seat)}'s ${turn.phase} phase · waiting for ${holder ? who(holder) : 'nobody'}`;
  }
  const reversed = view.turnDirection === 'toPredator' ? ' · play passes to the predator' : '';
  return `Turn ${turn.number} · ${who(turn.seat)} · ${turn.phase} phase${reversed}`;
}
