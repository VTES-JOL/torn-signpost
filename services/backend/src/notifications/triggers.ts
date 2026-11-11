/**
 * What to notify whom about after a command (NOTIF-01, TEMPO-01, docs/m5b-plan.md increment 5).
 * Pure: it compares the game before and after, so a wait that starts and ends within the same
 * command never notifies. Nobody is notified about something they did themselves, and players at
 * the table aren't notified that it's their turn or their decision: they can see it.
 */
import {
  type GameEvent,
  type GameState,
  type JUDGE_CALL_REASONS,
  type JudgeCall,
  type WaitKind,
  waitingOn,
} from '@torn-signpost/engine';
import type { NotificationKind } from '@torn-signpost/protocol';

export interface Draft {
  user: string;
  kind: NotificationKind;
  text: string;
}

const WAIT_TEXT: Record<Exclude<WaitKind, 'phase'>, string> = {
  impulse: 'Play a card or pass',
  block: 'An action is coming your way: block it or let it through',
  resolve: 'Resolve your action: did it succeed?',
  combat: 'Combat is waiting on you',
  vote: 'A referendum is waiting for your votes',
};

const REASON_TEXT: Record<(typeof JUDGE_CALL_REASONS)[number], string> = {
  'slow-play': 'slow play',
  rules: 'a rules question',
  dispute: 'a dispute',
  deadline: 'a deadline that passed',
  'time-limit': 'the time limit',
  other: 'something else',
};

export function gameNotifications(input: {
  before: GameState;
  after: GameState;
  events: readonly GameEvent[];
  /** The user whose command it was; the system's own checks have none. */
  actor?: string | undefined;
  /** Judges to tell about new judge calls. */
  judges?: readonly string[];
  /** Admins to tell about escalations (GAME-19). */
  admins?: readonly string[];
}): Draft[] {
  const { before, after, events, actor } = input;
  const out: Draft[] = [];
  const add = (user: string | undefined, kind: NotificationKind, text: string) => {
    if (!user || user === actor) return;
    if (out.some((d) => d.user === user && d.kind === kind)) return;
    out.push({ user, kind, text });
  };
  const occupant = (seat: string | undefined) =>
    after.seats.find((s) => s.id === seat)?.occupant ??
    before.seats.find((s) => s.id === seat)?.occupant;
  const away = (seat: string) => !after.seats.find((s) => s.id === seat)?.present;

  if (before.status === 'setup' && after.status === 'active') {
    for (const s of after.seats) add(s.occupant, 'started', 'The game has started');
  }

  for (const ev of events) {
    switch (ev.type) {
      case 'DeadlineReminded':
        add(occupant(ev.seat), 'deadline', 'Half your time to decide has gone');
        break;
      case 'Ousted':
        add(
          occupant(ev.seat),
          'ousted',
          ev.disqualified ? 'A judge disqualified you' : 'You were ousted',
        );
        break;
      case 'WithdrawalBroken': {
        const why = {
          pool: 'you lost or spent pool',
          blood: 'a vampire of yours lost or spent blood',
          combat: 'a minion of yours entered combat',
        }[ev.reason];
        add(occupant(ev.seat), 'withdrawal', `Your withdrawal no longer holds: ${why}`);
        break;
      }
      case 'Withdrew':
        add(occupant(ev.seat), 'withdrawal', 'You withdrew from the game (+½ VP)');
        break;
      case 'GameEnded':
        for (const s of after.seats) {
          const won = ev.winner === s.id;
          add(
            s.occupant,
            'ended',
            won
              ? `The game is over: you won${ev.gameWin ? ' (a game win)' : ''}`
              : 'The game is over',
          );
        }
        break;
      case 'JudgeCalled':
        for (const j of input.judges ?? []) {
          add(j, 'judge-call', `Judge call: ${REASON_TEXT[ev.call.reason]}`);
        }
        break;
      case 'JudgeCallResolved': {
        if (ev.auto) break;
        const call: JudgeCall | undefined = before.judgeCalls?.find((c) => c.id === ev.id);
        add(occupant(call?.by), 'ruling', 'A judge ruled on your call');
        if (ev.ruling.kind === 'escalate') {
          for (const a of input.admins ?? []) {
            add(a, 'escalation', 'A judge referred a game to the admins');
          }
        }
        break;
      }
    }
  }

  if (after.status !== 'active') return out;
  const turnChanged =
    !!after.turn &&
    (before.turn?.number !== after.turn.number || before.turn?.seat !== after.turn.seat);
  if (turnChanged && after.turn && away(after.turn.seat)) {
    add(occupant(after.turn.seat), 'turn', `Your turn (turn ${after.turn.number})`);
  }
  const was = new Set(waitingOn(before).map((w) => `${w.seat}:${w.kind}`));
  for (const w of waitingOn(after)) {
    if (was.has(`${w.seat}:${w.kind}`) || !away(w.seat)) continue;
    // The start of your turn is the "turn" notification.
    if (w.kind === 'phase') {
      if (!turnChanged) add(occupant(w.seat), 'decision', `Your ${after.turn?.phase} phase`);
      continue;
    }
    add(occupant(w.seat), 'decision', WAIT_TEXT[w.kind]);
  }
  return out;
}

/**
 * Who a chat message @mentions: anyone in the game whose name follows an @, ignoring case. Names
 * may contain spaces, so each name is looked for whole; the longest match wins.
 */
export function mentioned(
  text: string,
  people: readonly { user: string; name: string }[],
  author: string,
): string[] {
  const lower = text.toLowerCase();
  const out = new Set<string>();
  for (const p of people) {
    if (p.user === author || !p.name) continue;
    const at = `@${p.name.toLowerCase()}`;
    for (let i = lower.indexOf(at); i >= 0; i = lower.indexOf(at, i + 1)) {
      const next = lower[i + at.length];
      if (next === undefined || !/[\p{L}\p{N}_-]/u.test(next)) {
        out.add(p.user);
        break;
      }
    }
  }
  return [...out];
}
