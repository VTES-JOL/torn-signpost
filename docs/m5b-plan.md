# M5b plan: presence, time, judges and notifications

M5a gave the table a structured flow: phases, actions, block windows, the toolbar, holds, stops,
overrides and ousting. M5b adds what happens *around* that flow: who is at the table, how long
things may take, what happens when someone is slow or away, and how players find out the game is
waiting on them. Requirements covered: TEMPO-01/03/04/05/06, GAME-18, NOTIF-01/02, UX-09; design
in architecture §4.4. Not covered here: NOTIF-03 (Web Push, a "should", after M5b), APNs (with the
Mac app, M8), NOTIF-04 Discord and TEMPO-07 vacation status (both "could").

Every increment ships dark behind a feature flag (`presence`, `clock`, `judgeCalls`,
`notifications`, `email`), on locally, as `replay` is today.

## Current state

| Area | What exists | What's missing |
|---|---|---|
| Connections | `CONN#` and `SUB#<game>` items (TTL 3 h); `$connect`/`$disconnect`; per-game fan-out | Who is *present* in a game; any notion of a user's connections across games |
| Engine | Windows, impulse holder, actions, auto-pass, holds, ousting | Presence, a clock, deadlines, judge calls, "who is the game waiting on" as one function |
| Infra | HTTP + WebSocket APIs, one table, Lambdas | Scheduler, queues, a timers Lambda, SES |
| Web | ● in the tab title when the table waits on you | Presence, timers, prompts, judge calls, notifications |

## Design decisions

1. **"Waiting on" is derived, not stored.** The architecture sketched a stored `pending: Decision[]`.
   The engine already knows who it waits on (impulse holder, the acting player at resolution, the
   two players in combat, the phase owner), so a pure `waitingOn(state)` function replaces it.
   Everything below (prompts, deadlines, notifications) reads that one function.
2. **Time lives in the event log.** Every event carries `at`, so `evolve` can run the clock
   deterministically: elapsed time accumulates between events while the clock runs. Replays and
   scenarios reproduce it exactly. Nothing reads the wall clock inside the engine.
3. **The engine decides deadlines; the server only schedules them.** After every command, a
   post-step (like `withOusts`) sets or clears deadlines from `waitingOn` and presence. The server
   compares deadlines before and after and creates or deletes timers. A timer firing becomes a
   system command, which the engine checks against the current state (idempotent by design).
4. **Presence is debounced on the server**, ~30 s on absence, so a network blip or page reload
   doesn't flip the game to async. Arrival is immediate.
5. **One timer abstraction.** `Timers.schedule(key, at, payload)` / `cancel(key)`: EventBridge
   Scheduler one-off schedules in AWS (`ActionAfterCompletion: DELETE`), in-process timers locally.
   Short delays (presence debounce, email delay) use the same interface.

## Increments

### M5b.1 Presence (TEMPO-06): done

Built as planned, with a `SetPresence` system command, the `Timers` abstraction and its infra
(scheduler group, timers Lambda, dead-letter queue and alarms) brought forward from M5b.3, and an
`audience` WebSocket message for the spectator count.

- **Engine**: system events `PlayerPresent{seat}` / `PlayerAbsent{seat}`; `Seat.present`. Seated
  players only: spectators and judges are shown but don't affect the game's tempo. `tempo(state)`
  returns `live` when every live seat is present, else `async`.
- **Backend**: a user↔game presence count from `SUB#` items. On subscribe, issue `PlayerPresent`
  if the seat was absent. On unsubscribe or disconnect, when the user has no other subscription to
  the game, schedule a presence check in 30 s that issues `PlayerAbsent` if they're still gone.
  System commands go through the normal command pipeline (`by: system`), so they're logged,
  projected and pushed like any other event.
- **Web**: a presence dot on each seat header; "Bob is away" in the status line; spectator count.
- **Log**: presence changes are bookkeeping, not log lines (like automatic passes).
- **Tests**: scenario directives `present B no` / `present B yes`; backend integration test for
  the debounce with fake timers.

### M5b.2 Waiting-on and decision prompts (UX-09): done

Built as planned. `since` comes from `state.waiting`, which `evolve` restarts whenever the wait
changes (a different seat or kind, or a new phase or turn), so M5b.3's deadlines can count from it.

- **Engine**: `waitingOn(state): { seat; kind; since }[]`, where `kind` is `phase`, `impulse`,
  `block`, `resolve`, `combat`; `since` is the seq/time the wait began.
- **Web**: a prompt card in the flow bar owned by the deciding seat ("Your decision: block
  Julia Prima's bleed?") with the relevant offers, and for everyone else "Waiting on Bob (block
  decision)". Non-blocking, keyboard reachable, live-region announced. Timers appear here once
  M5b.3 lands.
- **Tests**: unit tests over the flow states; the property tests check `waitingOn` is never empty
  while the game is active and never names an ousted seat.

### M5b.3 Table timer and async deadlines (TEMPO-03/04/05): done

Built with these decisions: an expired deadline **never acts for the player**; it's logged and
flags the game for a judge (the judge call itself comes with increment 4). Games with a table timer
can be **paused** by any player or a judge for 1–5 minutes at a time; play stops while paused, and
the pause ends by itself or is lifted early by whoever paused or a judge. Deadlines are derived
(`deadlines(state)`) rather than stored as `DeadlineSet`/`DeadlineCleared` events; only reminders,
expiries and the time limit are events. Checks are one `timers(state)` list the server diffs.

- **Engine state**:
  - `clock: { limitMs, elapsedMs, runningSince? }`: runs while the game is `live`, active, and no
    judge call is open; paused otherwise (DQ7). `evolve` updates it from event timestamps.
  - `deadlines: { seat, kind, dueAt, reminded }[]`: one per wait owned by an *absent* seat. Set by
    the post-step when a wait begins with its owner absent, or the owner leaves mid-wait; cleared
    when the wait ends or the owner returns.
- **Settings**: `GameSettings.timeLimitMs` and `deadlineMs` (default 24 h), chosen at game
  creation in the lobby. The table timer is **optional in casual games** (off unless the creator
  sets one) and **always on in tournament games**, at least 2 h (Tournament Rules 3.1.1: the
  minimum, announced before play). Tournament values come from the tournament in M7, through the
  same fields. With no time limit the clock still shows elapsed time.
- **Events**: `DeadlineSet`, `DeadlineCleared`, `DeadlineReminded`, `TimeLimitReached`.
- **Backend**: diff `deadlines` and the clock's projected end after each command; schedule the
  12 h reminder, the expiry, and the time-limit check through `Timers`. A timers Lambda turns each
  firing into a system command (`RemindDeadline`, `ExpireDeadline`, `CheckTimeLimit`) that the
  engine validates against current state, so stale timers do nothing.
- **Time limit reached** (Tournament Rules 3.1.1): the game is in its final stretch and ends with
  the current minion action, if any, or at the end of the current phase. M5b records
  `TimeLimitReached` and announces it; ending the game there and scoring it (0.5 VP to each
  survivor, a full VP to a lone survivor, Rules 3.7.2) is game-end logic for M6. Judges can add
  time for judge-caused delays (Conduct Guide 1.2.4) with `ExtendTime{minutes}`.
- **Infra**: Scheduler group and execution role, timers Lambda with a DLQ, alarms on failures.
- **Web**: the clock in the flow bar (counting down; "paused: async" or "paused: judge call");
  deadline countdowns on prompts; the lobby's create form gains the two settings.
- **Tests**: scenario directive `wait 25h` advances the scenario clock; scenarios for set,
  clear-on-return, remind, expire, and clock pause/resume.

### M5b.4 Judge calls and the judge queue (GAME-18): done

Built as planned, with: call IDs are `c<seq>` of the opening event; rulings are part of
`ResolveJudgeCall` (no separate `PassFor`/`ExtendDeadline` commands), plus `answered` and
`escalate`; a `deadline` call settles itself when the player comes back or the game moves on;
the judge queue page refreshes every 15 s until notifications (M5b.5) push new calls.

A call waits until a judge responds: there is no fallback. To keep that workable, outstanding
calls live in a queue that judges can see and work through together.

- **Engine** (the call as part of the game):
  - `judgeCalls: { id, reason, by, openedAt, seat?, ref?, note?, claimedBy?, status }[]`, with
    `reason` one of `slow-play`, `rules`, `dispute` (an unverified override; `ref` is its event
    seq), `deadline`, `time-limit`, `other`.
  - Commands: `CallJudge{reason, seat?, ref?, note?}` (any seated player), `ClaimJudgeCall{id}`
    (a judge takes it, so two judges don't answer the same call), `ResolveJudgeCall{id, ruling}`.
    Any open call pauses the table timer.
  - Rulings, all audited with `by: judge`: `ExtendDeadline{seat, hours}`, `PassFor{seat}` (the
    default pass for an expired decision), `ExtendTime{minutes}`, `Disqualify{seat}` (tournament
    games), plus the existing primitives and `CancelAction` for disputes.
- **Queue** (backend): every open call is also an item in a judge queue
  (`JUDGEQ / <openedAt>#<gameId>#<callId>`, removed when resolved). Tournament calls route to the
  tournament's judges once M7 exists; until then, everything goes to the global `judge` group.
  `GET /judge/calls?status=open|claimed` lists them with game, table, reason, age and claimant.
- **Judge queue page** (web, judges only): all outstanding calls, oldest first, filterable by
  reason and tournament, showing who has claimed what; claim a call and jump into the game with
  the ruling tools. New calls arrive live over the WebSocket and as notifications (M5b.5).
- **Expiry never decides** (DQ6): `ExpireDeadline` opens a `deadline` call; the absent player may
  still respond until a judge rules, which resolves the call automatically.
- **Removing a player whose deadline expired** depends on the game:
  - *Tournament*: the judge may **disqualify** (Conduct Guide 1.1.4, 4.11: going absent without
    telling a judge counts as abandoning the game). A disqualification is **not an oust**: the
    predator gains no VP and no pool, all of the player's cards in play, uncontrolled region, hand
    and pool leave the table, and predator and prey close up. `Seat.disqualified` joins `ousted` and
    `withdrawn` as "out of the game". Mid-game replacement isn't allowed in tournaments.
  - *Casual*: the judge escalates to a **server admin, who replaces the player** with
    `ReplacePlayer` (GAME-19, already built for admins). A request queue for admins is a later
    feature; for now the ruling records the escalation and the admin acts on it.
- **Web**: a "Call a judge" button (reason + note) for seated players; the open call and its
  claimant in the flow bar; the table's judge view with the ruling tools in the toolbar.
- **Tests**: scenarios for each reason, claiming, clock pausing, each ruling, disqualification
  (no VP, no pool, cards removed, seating closes up) and permissions; service tests for the queue.

### M5b.5 In-app notifications (NOTIF-01, TEMPO-01): done

Built as planned, with: the unread count is counted from the latest 50 notifications rather than
kept as a counter on the profile (always right, and shown as "50+" beyond that); judge-call
notifications go to judges seen in the last 30 days (`JUDGES` items, refreshed as they connect),
since judges are a Cognito group the backend can't list; players at the table get no turn or
decision notifications (they can see them); and the web app opens a socket of its own for
notifications. Behind the `notifications` flag in the web app; the backend always records them.


- **Store**: `USER#<sub> / NOTIF#<ts>#<id>` (TTL 30 days), with an unread counter on the profile;
  `USERCONN#<sub> / CONN#<id>` so a user's open connections can be reached from any game.
- **Triggers** (computed by the service after each command by comparing `waitingOn` before and
  after, and on chat): your turn; block or decision waiting on you; mentioned in chat; judge call
  opened (to judges) or ruled (to the caller); deadline reminder; you were ousted; game started.
  No notification for the player who caused it, or for waits that end within the same command.
- **API**: `GET /me/notifications?before=`, `POST /me/notifications/read` (ids or all); WebSocket
  `notification` messages to every connection the user has.
- **Web**: a bell with unread badge in the header, a dropdown list linking into games, and the tab
  title count.
- **Tests**: service unit tests for each trigger and for no self-notifications; integration test
  for push to a second connection.

### M5b.6 Email (NOTIF-02): done

Built as planned, with:
- **The delay uses the timers** (EventBridge Scheduler one-off schedules, design decision 5)
  rather than an SQS delay queue: one less moving part, and the same idempotent "check when it
  fires" pattern.
- **A sixth category, `game`** (a game starting, being ousted), in the digest by default.
- **Digests at 05:00 and 17:00 UTC** (daily: the evening one), from two recurring schedules.
  Users' time zones aren't known yet.
- **The address** is the verified one from the Cognito ID token, kept on `USER#<sub> / EMAIL` as
  users make requests. Local dev users get `<name>@example.test`, and locally emails are printed by
  the API process instead of sent.
- **Unsubscribe links** are signed (HMAC, key in Secrets Manager). Opening the web page changes
  nothing (mail scanners open links); its button, or a mail client's one-click POST
  (RFC 8058 `List-Unsubscribe-Post`), does.
- **"Away"** means no open connection at all (`USERCONN#`), so any open tab counts as present.
- The backend switch is `emailEnabled` (infra config), on for the beta; the
  Account page settings are behind the `email` flag. The unsubscribe page is always there.


The SES set-up (identity, DNS records, production-access request) is done first, at the start of
M5b, since AWS approval takes a day or more; only the sending code waits for this increment.

- **Preferences**: `USER#<sub> / PREFS`: per kind (`turn`, `decision`, `mention`, `judge`,
  `deadline`) one of `immediate`, `digest`, `off`; digest daily or twice daily. Defaults: deadlines
  and judge matters immediate; the rest in a daily digest. Shown on the Account page.
- **Only when away**: an email is queued with a delay (~2 min) and sent only if the notification is
  still unread and the user isn't connected, so an active player never gets email.
- **Delivery**: SQS delay queue → sender Lambda → SES. Digest: a scheduled job gathers unsent
  digest items per user. Every email carries a one-click unsubscribe (`List-Unsubscribe` +
  signed link) and never another player's email address (NFR-06).
- **Infra** (CDK): an SES domain identity for `tornsignpost.org` with Easy DKIM, a custom MAIL FROM
  domain (`mail.tornsignpost.org`) with its SPF and MX records, and a DMARC record, all in the
  existing Route 53 zone; a configuration set that adds bounced and complaining addresses to the
  SES account suppression list (no further sends to them), with reputation metrics. Sender:
  `notifications@tornsignpost.org`. Built in `infra/lib/email-stack.ts`.
- **Manual step (you)**: request SES production access in the AWS console (us-east-1), describing
  transactional game notifications with opt-in preferences and one-click unsubscribe. Until it is
  approved, SES only sends to verified addresses, which is fine for testing.
- **Tests**: unit tests for preference resolution and the "still away?" check; integration test
  with a fake mailer; local dev logs emails to the console instead of sending.

### Review fixes (after M5b.6)

A review against the plan, the requirements and the original intent found five gaps, now fixed:
1. **Beta flags**: email reached beta players about deadlines and judge calls while those features
   were dark there; `presence`, `clock`, `judgeCalls` and `notifications` are now on for the beta.
2. **Read state**: notifications were only marked read from the bell, so stale turns went out by
   email. Opening a game now marks its notifications read, and a turn or decision notification is
   marked read once the game stops waiting on that player (`notifications-read` pushes keep every
   tab's bell in step).
3. **Away**: an open tab used to count as present forever. "Away" is now no connection, or none
   used for 15 minutes (`USER#<sub> / ACTIVE`, from changes over HTTP, opening a game and the web
   app's `active` messages on input; pings and polling don't count).
4. **Escalations**: an `escalate` ruling closed the call and went nowhere. It now lands in an
   admin queue (`ADMINQ`), admins are notified, and the `/admin` page replaces the player by
   display name or dismisses it (GAME-19).
5. **Pause allowance**: pauses could be chained without limit. Each player now has 15 minutes of
   pauses per game; judges can still pause beyond that.

## Order and size

| # | Increment | Depends on | Rough size |
|---|---|---|---|
| 0 | SES identity, DNS and production-access request | — | half a day + AWS approval |
| 1 | Presence | — | 1–2 days |
| 2 | Waiting-on and prompts | — | 1–2 days |
| 3 | Timer and deadlines | 1, 2 | 3–4 days |
| 4 | Judge calls and the judge queue | 3 | 3–4 days |
| 5 | In-app notifications | 2 (4 for judge kinds) | 2–3 days |
| 6 | Email | 0, 5 | 2–3 days |

Presence and waiting-on are independent and can go in either order.

## Docs to update as each lands

`docs/flow.md` (waiting-on, judge rulings), `docs/console.md` (new commands and scenario
directives: `present`, `wait`, `judge`, `extend`, `passfor`, `remove`), `docs/02-architecture.md`
(§4.4 implementation notes; store key table), and the README (local timers and email logging).

## Decisions

1. **Table timer**: optional at game creation for casual games; always on in tournaments (at least
   2 h, Tournament Rules 3.1.1).
2. **Judge calls wait for a judge**, with no fallback. Outstanding calls are held in a judge queue,
   and judges get a page showing every outstanding call so they can share the load.
3. **Email through SES** on `tornsignpost.org`, set up first (increment 0).
4. **Email defaults** as planned: deadlines and judge matters immediately, the rest in a daily
   digest, and only while the player is away.
5. **Removing a player**: in tournaments, judges disqualify per the VEKN Conduct & Infraction Guide
   (not an oust: no VP or pool for the predator). In casual games, a judge escalates to a server
   admin, who replaces the player; an admin request queue is a later feature.

## Later (noted, not in M5b)

- Recording tournament penalties (cautions, warnings) against players: with tournaments, M7.
- Ending the game at the time limit and timeout scoring: with game end, M6.
- Web Push (NOTIF-03), APNs (M8), Discord webhooks (NOTIF-04), vacation status (TEMPO-07).
