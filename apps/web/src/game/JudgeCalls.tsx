/**
 * Judge calls at the table (GAME-18): open calls for everyone to see, a "Call a judge" form for
 * players, and claiming and ruling for judges. Everything goes through the normal commands, so
 * every step is in the log.
 */
import {
  type GameState,
  type JudgeCall,
  PLAYER_CALL_REASONS,
  type Ruling,
} from '@torn-signpost/engine';
import type { PlayerCommand } from '@torn-signpost/protocol';
import { useState } from 'react';

export const REASON_LABELS: Record<JudgeCall['reason'], string> = {
  'slow-play': 'Slow play',
  rules: 'Rules question',
  dispute: 'Dispute',
  deadline: 'Deadline passed',
  'time-limit': 'Time limit reached',
  other: 'Other',
};

const RULINGS: { kind: Ruling['kind']; label: string; tournament?: boolean; casual?: boolean }[] = [
  { kind: 'answered', label: 'Answered at the table' },
  { kind: 'pass-for', label: 'Pass for the player' },
  { kind: 'extend-deadline', label: 'More time to decide' },
  { kind: 'extend-time', label: 'Add time to the timer' },
  { kind: 'disqualify', label: 'Disqualify', tournament: true },
  { kind: 'escalate', label: 'Refer to a server admin', casual: true },
];

export function JudgeCalls(props: {
  view: GameState;
  seat: string | undefined;
  judge: boolean;
  user: string | undefined;
  seatName: (seat: string) => string;
  send: (command: PlayerCommand) => void;
}) {
  const { view, seat, judge, user, seatName, send } = props;
  const [calling, setCalling] = useState(false);
  if (view.status !== 'active') return null;
  const calls = view.judgeCalls ?? [];
  const mineOpen = !!seat && calls.some((c) => c.by === seat);
  if (!calls.length && !seat) return null;
  return (
    <section className="judge-calls" aria-label="Judge calls">
      {calls.map((c) => (
        <div key={c.id} className="judge-call" role="status">
          <span className="badge">{REASON_LABELS[c.reason]}</span>{' '}
          <span>
            {c.by ? `${seatName(c.by)} called a judge` : 'The game called a judge'}
            {c.seat ? ` about ${seatName(c.seat)}` : ''}
            {c.note ? `: “${c.note}”` : ''}
          </span>{' '}
          <span className="muted small">
            {c.claimedBy
              ? c.claimedBy === user
                ? 'you are handling it'
                : 'a judge is handling it'
              : 'waiting for a judge'}
          </span>
          {judge && <JudgeTools call={c} view={view} user={user} seatName={seatName} send={send} />}
        </div>
      ))}
      {seat && !mineOpen && !calling && (
        <button type="button" className="judge-call-button" onClick={() => setCalling(true)}>
          Call a judge
        </button>
      )}
      {calling && seat && (
        <CallForm
          view={view}
          seatName={seatName}
          onCancel={() => setCalling(false)}
          onCall={(command) => {
            send(command);
            setCalling(false);
          }}
        />
      )}
    </section>
  );
}

function CallForm(props: {
  view: GameState;
  seatName: (seat: string) => string;
  onCall: (command: PlayerCommand) => void;
  onCancel: () => void;
}) {
  return (
    <form
      className="toolbar"
      onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        const reason = data.get('reason') as (typeof PLAYER_CALL_REASONS)[number];
        const about = String(data.get('seat') ?? '');
        const note = String(data.get('note') ?? '').trim();
        props.onCall({
          type: 'CallJudge',
          reason,
          ...(about ? { seat: about } : {}),
          ...(note ? { note } : {}),
        });
      }}
    >
      <select name="reason" aria-label="Reason" defaultValue="rules">
        {PLAYER_CALL_REASONS.map((r) => (
          <option key={r} value={r}>
            {REASON_LABELS[r]}
          </option>
        ))}
      </select>
      <select name="seat" aria-label="About" defaultValue="">
        <option value="">About nobody in particular</option>
        {props.view.seats
          .filter((s) => !s.ousted && !s.withdrawn)
          .map((s) => (
            <option key={s.id} value={s.id}>
              About {props.seatName(s.id)}
            </option>
          ))}
      </select>
      <input name="note" aria-label="What happened" placeholder="What happened?" maxLength={500} />
      <button type="submit" className="primary">
        Call
      </button>
      <button type="button" onClick={props.onCancel}>
        Cancel
      </button>
    </form>
  );
}

function JudgeTools(props: {
  call: JudgeCall;
  view: GameState;
  user: string | undefined;
  seatName: (seat: string) => string;
  send: (command: PlayerCommand) => void;
}) {
  const { call, view, user, seatName, send } = props;
  const [kind, setKind] = useState<Ruling['kind']>(
    call.reason === 'deadline' ? 'pass-for' : 'answered',
  );
  const tournament = view.settings.tournament;
  const live = view.seats.filter((s) => !s.ousted && !s.withdrawn);
  if (call.claimedBy && call.claimedBy !== user) return null;
  const choices = RULINGS.filter(
    (r) => (!r.tournament || tournament) && (!r.casual || !tournament),
  ).filter((r) => r.kind !== 'extend-time' || view.settings.timeLimitMs !== undefined);
  const needsSeat = kind === 'pass-for' || kind === 'extend-deadline' || kind === 'disqualify';
  return (
    <form
      className="toolbar judge-tools"
      onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        const s = String(data.get('seat') ?? call.seat ?? '');
        const n = Number(data.get('amount'));
        const note = String(data.get('note') ?? '').trim();
        const ruling: Ruling =
          kind === 'pass-for'
            ? { kind, seat: s }
            : kind === 'extend-deadline'
              ? { kind, seat: s, hours: n || 12 }
              : kind === 'extend-time'
                ? { kind, minutes: n || 10 }
                : kind === 'disqualify'
                  ? { kind, seat: s }
                  : { kind };
        send({ type: 'ResolveJudgeCall', id: call.id, ruling, ...(note ? { note } : {}) });
      }}
    >
      {!call.claimedBy && (
        <button type="button" onClick={() => send({ type: 'ClaimJudgeCall', id: call.id })}>
          Claim
        </button>
      )}
      <select
        aria-label="Ruling"
        value={kind}
        onChange={(e) => setKind(e.target.value as Ruling['kind'])}
      >
        {choices.map((r) => (
          <option key={r.kind} value={r.kind}>
            {r.label}
          </option>
        ))}
      </select>
      {needsSeat && (
        <select name="seat" aria-label="Player" defaultValue={call.seat ?? live[0]?.id}>
          {live.map((s) => (
            <option key={s.id} value={s.id}>
              {seatName(s.id)}
            </option>
          ))}
        </select>
      )}
      {(kind === 'extend-deadline' || kind === 'extend-time') && (
        <label className="small">
          {kind === 'extend-deadline' ? 'Hours' : 'Minutes'}{' '}
          <input
            name="amount"
            type="number"
            min={1}
            max={kind === 'extend-deadline' ? 168 : 120}
            defaultValue={kind === 'extend-deadline' ? 12 : 10}
            size={3}
          />
        </label>
      )}
      <input
        name="note"
        aria-label="Ruling note"
        placeholder="Note for the table"
        maxLength={500}
      />
      <button type="submit" className="primary">
        Rule
      </button>
    </form>
  );
}
