# M6 plan: the full game

M6 makes a game a complete game: it ends, it is scored, results are kept, and the two big
structured flows the tabletop still leaves to the players (combat and referendums) get guided
steps. Roadmap: "Combat, referendums, ousting/VP/GW, withdrawal, game end, stats, spectators"
(architecture §13; GAME-07..09, GAME-16, STATS-*). It also takes what M5b deferred: ending the
game at the time limit, and timeout scoring.

Rules follow zero-vtes's rulings where sources disagree (`docs/rules-qa.md` there; rule numbers
below are its), then the VEKN rulebook and Tournament Rules, then the JOL rules docs.

## Current state

| Area | What exists | What's missing |
|---|---|---|
| Ousting | Pool ≤ 0 ousts; predator gains 1 VP and 6 pool (none if ousted by the same effect); cards leave; turn and action handling (GAME-08, GAME-21, DQ9); disqualification | The game never ends: `status: 'finished'` is never set |
| VP | `Seat.vp`, `AdjustVp` | Last-standing VP, timeout half points, game win (GW), a result |
| Time limit | `TimeLimitReached` and a judge call (M5b.3) | Ending the game there, and timeout scoring |
| Withdrawal | `Seat.withdrawn` in the model | The rulebook procedure: announcing, the conditions, the half point |
| Combat | A blocked action goes to `stage: 'combat'`; players play it out with the primitives until `EndCombat` | Range, strikes, damage, prevention, presses, rounds, torpor as steps (GAME-07) |
| Referendums | Nothing: a political action is resolved by hand | Terms, the polling window, votes and ballots, the tally, blood hunts |
| Stats | Nothing | Results per game, player stats, leaderboards (STATS-01..03) |
| Spectators | Public games watchable by anyone, guests included; the spectator count (GAME-16) | A finished game's result for everyone watching |

**A bug the beta check found** (2026-11-05): in a game where every Methuselah was ousted, the turn
passed to an ousted seat ("Turn 4 · Player 34b8 · unlock phase") and the game stayed active.
`nextTurn` falls back to the current seat when no live seat is left, and nothing ends the game.
Increment 1 fixes it.

## Design decisions

1. **Game end is part of the engine's post-steps**, like ousting: after every command, if one live
   Methuselah or none is left, the engine appends `GameEnded` with the result. No command ends a
   natural game; admins (and, if decision Q3 says so, players by agreement) end the others.
2. **The result is an event**: `GameEnded{reason, vp, gw?, survivors}`. Scoring, stats and
   tournament results all read that one event, so a replay gives the same result.
3. **Stats come from the event**, written by the game service when it appends `GameEnded`
   (architecture §5.8 sketched a stream Lambda; the service already does the judge queue the same
   way, so this avoids a new moving part). Replaced players follow DQ8.
4. **Combat and referendums are guided, not automated.** Like the action flow, the engine runs
   the steps, windows and bookkeeping (range, rounds, the tally); card effects stay with the
   players through the primitives and overrides. Card automation remains post-MVP (GAME-14).
5. **Every step can be skipped or overridden**, as GAME-06 asks of the action flow: a player who
   knows what happened can say so rather than click through.

## Rules questions to settle first

| # | Question | Sources | Recommendation |
|---|---|---|---|
| Q1 | How much is a withdrawal worth? | Rulebook: 1 VP. VEKN Tournament Rules and zero-vtes 90.9: half a VP | **Half a VP everywhere**, as zero-vtes rules (one scoring rule for every game) |
| Q2 | When does a game at its time limit end? | M5b plan, from Tournament Rules 3.1.1: with the current minion action, if any, or at the end of the current phase | As in the M5b plan: the engine ends it there; an admin can end it at once |
| Q3 | Can a casual game end early by agreement? | Not in the rules; tournaments allow no such thing | **Yes for casual games**: every Methuselah still in the game agrees, scored as a timeout. Tournament games end only naturally, at the time limit, or by an admin |
| Q4 | How far does combat go? | GAME-07 is a "should"; zero-vtes batches 4, 21, 22, 29 | **Guided steps** (range, strikes chosen each round, damage, prevention, presses, torpor), with card effects by hand. No card-specific automation |
| Q5 | Where do votes come from? | Titles, the Edge, political action cards, Prisci ballots (zero-vtes 5.1–5.4, Batch 19) | Players **declare** their votes from those sources; the engine checks what it can know (the Edge, the calling card's vote, titles printed on vampires in play) and tallies. Unknown sources are accepted as overrides, like grants |
| Q6 | What do stats count? | STATS-01..03, DQ8 | ~~Every finished game; leaderboards from games with at least 4 players~~ **Superseded (2026-11-05, M6.3)**: only casual games of 5 players and tournament games count, by format, calendar-year seasons; replaced players as DQ8 |

## Increments

### M6.1 Game end and scoring (GAME-08/09): done

Built as planned, except that **admins**, not judges, end games early (decided 2026-11-05).
Players are notified when a game ends (`ended`, in the `game` email category).
A simultaneous oust of everyone left can't be produced with the primitives yet (one command changes
one pool), so it is covered by the rules in `gameEnded` and the property test, and gets a scenario
once combat or card effects can cause one.


- **Engine**: a `withGameEnd` post-step after `withOusts`:
  - one live Methuselah left: they gain 1 VP for being the last standing, and the game ends
    (`reason: 'last-standing'`);
  - none left (a simultaneous oust, zero-vtes 6.9): every Methuselah in play at that moment
    scores for an ousted prey, and the game ends with no survivor;
  - the game win (GW) goes to whoever has at least 2 VP and strictly more than everyone else,
    ousted or not; draws are legal (6.9). The Life Boon rules (45.5) apply when that card lands.
- **Time limit** (Q2): after `TimeLimitReached`, the game ends when the current minion action
  ends, or at the end of the current phase with none; survivors get half a VP each, a lone
  survivor the full survivor VP (Tournament Rules 3.7.2) (`reason: 'time-limit'`).
- **Ending by admins**, and by agreement in casual games (Q3): `EndGame{reason}` from an admin, or
  `ProposeEnd` / `AgreeEnd` from the players, scored as a timeout.
- **The bug**: `nextTurn` never hands the turn to a seat that is out; with nobody left, the game
  has ended first. A property test: an active game's turn always belongs to a live seat.
- **Backend and web**: the lobby shows finished games and their result; the table shows the final
  standings to everyone, spectators included; timers, deadlines and judge calls stop.
- **Tests**: scenarios for each ending (last standing, simultaneous, time limit in and out of an
  action, admin, agreement), GW edge cases (an ousted winner, draws); property tests (games end
  only by these rules; VP never exceeds the table's maximum, timeouts aside).

### M6.2 Withdrawal (GAME-09): done

A Methuselah whose library has run out can leave the game with half a victory point instead of
playing on until ousted (rulebook "Withdrawing from the Game"; zero-vtes rules-qa 90.9 and Batch
95; Q1: half a VP everywhere). The game state tracks it from start to finish: no judge and no
calling it off are needed (decided 2026-11-05).

**The rule, as built here:**
1. **Announcing** (95.3): in their own unlock phase, when their library is empty and they have
   less than a full hand. "A full hand" is their hand size, cards that raise or lower it included;
   the engine doesn't enforce hand size yet, so for now it means fewer than 7 cards (see Later).
   Public, and logged. One withdrawal at a time.
2. **Holding it** (95.1, 95.2, 95.4): announcing doesn't limit what they do; they play their turn as
   usual. But it is nullified, and logged, if before their next unlock phase
   - they lose or spend **pool**: a bleed, a pool adjustment down, blood moved from their pool
     (influence transfers included); a gain afterwards doesn't repair it;
   - a **vampire** of theirs in play (ready or torpor) loses or spends **blood**, whatever took it;
     a minion leaving play with its blood on it doesn't count (95.1), nor does an ally's life
     (95.2);
   - a **minion** of theirs **enters combat** (for now: blocked, or blocking; M6.4 adds the
     other ways in).
   Their own actions nullify it just as another player's do. Once nullified, they may announce
   again in a later unlock phase of theirs, if the conditions hold.
3. **Leaving** (95.4, 95.5): at the moment their next unlock phase would start, a withdrawal still
   held takes them out of the game. That turn isn't played; the next Methuselah's begins. They gain
   half a VP; it isn't an oust: their predator gains neither VP nor pool. Their cards leave the game
   as an ousted Methuselah's do, and predator and prey close up. If one Methuselah is left, they
   are the last standing and the game ends (M6.1).

**Engine:**
- `Seat.withdrawing?: { since: Seq }` (pending), alongside the existing `withdrawn?` (gone).
- One command, `Withdraw`, refused unless the conditions hold.
- Events: `WithdrawalAnnounced{seat}`, `WithdrawalBroken{seat, reason: 'pool'|'blood'|'combat'}`,
  `Withdrew{seat, vp: 0.5}`.
- A `withWithdrawals` post-step after the ousts: scans the command's events for pool decreases,
  blood decreases on the seat's vampires in play, and the start of a combat with their minions,
  and appends `WithdrawalBroken`.
- `nextTurn`: before starting a seat's turn, if it holds a withdrawal, emit `Withdrew` (and its
  cards' moves, as for an oust) and go on to the next seat; several in a row are each handled.
- `gameEnded` and `seatRefs` already treat `withdrawn` as out; the result table says "withdrew".

**Web:**
- A "Withdraw" offer in the flow bar, shown **only** when the player may withdraw: their own unlock
  phase, an empty library, a short hand, none pending. Otherwise there's no sign of it.
- It asks for confirmation first, saying what it means: "You'll leave the game at the start of your
  next turn, with ½ VP, if until then you lose or spend no pool, none of your vampires loses or
  spends blood, and none of your minions enters combat."
- A "withdrawing" badge on the seat for the whole table; the log lines.

**Notifications:** the player is told when their withdrawal is nullified (and why), and when it
takes them out (both in the `game` email category).

**Tests:**
- Scenarios after zero-vtes's: kept a round (half a VP, the turn skipped, predator unrewarded);
  nullified by a bleed, by influence transfers, by blood spent, by entering combat (blocking), by
  the player's own action; an ally losing life doesn't nullify it, nor does a vampire burned with
  blood on it; refused with a full hand, with cards left in the library, outside their unlock
  phase, or with one pending; announced again after being nullified; the last two players, one
  withdrawing, ending the game.
- Unit tests for each nullifying event and the permissions; the offer appears exactly when
  `Withdraw` would be accepted.
- Property tests: a withdrawn seat never gets the turn or acts; a pending withdrawal never
  survives a pool or blood loss.
- Browser: the offer, its confirmation, the badge, and a withdrawal taking effect.

### M6.3 Results and stats (STATS-01..03): done

Built as planned. Players' pages are reached by display name, or by their user key when they
haven't chosen one.


Counted games leave a result, and every player gets stats, a history and a place on the
leaderboards (STATS-01..03; architecture §5.8; replaced players as DQ8). Card and deck meta stats
(STATS-04) stay for later.

**Which games count** (decided 2026-11-05, replacing Q6's "at least 4 players"): **casual games
of 5 players, and tournament games** (any table size). Only these get a result, stats, a history
entry and leaderboard standing; every other game is still in its players' games list, but nowhere
in results. A counted game's result is **public, private games included** (S1): a 5-player
private game's result is as visible as a public one's.

**The result** (STATS-01): when a command ends a counted game, the game service writes
`GAME#<id> / RESULT`, built by a pure function from the game's meta and final state:
- the game: name, format, tournament or casual, players, how it ended (`GameEnded.reason`), the
  winner and any game win, started and ended times, the table timer's played time when it has one;
- each seat: the player who finished it (credited, DQ8), anyone they replaced (a "replaced"
  record: a game played, no GW or VP, out of the win rate), VP, game win, how they finished (still
  in, ousted, withdrew, disqualified), the deck and version they joined with, and the deck's main
  clan (S3).

**Stats** (STATS-02): per player, `USER#<sub> / STATS#<season>` (calendar year of the game's end,
UTC) and `USER#<sub> / STATS#all`: games, replaced, game wins, VP, wins, overall and per format.
Win rate = game wins ÷ games, replaced ones left out. Updated by one DynamoDB transaction with the
result's conditional put, so a retry never counts a game twice.

**History**: the membership item `USER#<sub> / GAME#<id>` gains the seat's result (VP, game win,
how they finished, the deck, the end time) for counted games, so a player's results list without
reading every game. Favourite decks and clans come from the same list. A player brought in by
`ReplacePlayer` now gets a membership item too (today they don't, so the game is missing from
their games list).

**Leaderboards** (STATS-03): each season's stats items are indexed on GSI1
(`STATS#<season>` / user), so a season is one query; the API ranks in memory and caches the board
for a few minutes. That serves thousands of players; a dedicated index (the architecture's GSI3)
can come with scale.

**Rebuilding** (S4): `pnpm --filter @torn-signpost/backend stats:rebuild` recomputes every result,
stat and history entry from the finished games' event logs, with the same rule for which games
count. For backfilling games finished before this ships, and for fixing stats after a rules
change. Result corrections by organisers come with tournaments (TOURN-05, M7).

**API:**
- `GET /users/{name}`: the public profile: display name, all-time and current-season stats, by
  format; favourite decks (public decks only, S5) and clans.
- `GET /users/{name}/games?before=`: their counted games, newest first, with VP, game win and how
  they finished.
- `GET /leaderboards?season=&format=&by=gw|vp|winrate`: players with at least 5 counted games that
  season (S2), ranked by game wins (default), VP or win rate; ties broken by GW, then VP, then fewer
  games.

**Web** (behind a `stats` flag):
- a player page, `/players/{name}`: stats (season picker), favourite decks and clans, results
  linking to each game;
- a leaderboards page, `/leaderboards`: season, format and ranking;
- player names in the lobby, at the table and in the game-over panel link to player pages.

**Tests:**
- Unit: which games count (5-player casual, tournament of any size; not 3- or 4-player casual);
  the result from a final state: every ending, ousted winners, draws, withdrawals,
  disqualifications, a replaced seat; the main clan of a deck, ties included.
- Integration: one result per game even when the write is retried; nothing recorded for a game
  that doesn't count; stats and history after games of each kind; a private 5-player game's
  result visible to everyone; the replaced player's record; a replacement's membership;
  leaderboard ranking, eligibility and ties; the rebuild reproducing the same stats.
- Browser: a finished 5-player game showing on its players' pages and on the leaderboard.

**Decisions** (2026-11-05):

| # | Question | Decision |
|---|---|---|
| S1 | Private games? | A counted private game's result is public, like any other |
| S2 | Leaderboards? | Players with at least 5 counted games that season; by game wins then VP by default, or by VP or win rate |
| S3 | Favourite clans? | Each deck's main clan: the most common clan among its crypt cards, from the card data; ties list both |
| S4 | Backfill and corrections? | A rebuild command recomputes everything from the event logs; organiser corrections with tournaments (M7) |
| S5 | Show which deck someone played? | Only if that deck is public; otherwise just its main clan |

### M6.4 Combat steps (GAME-07)

- **Engine**: combat as rounds of steps, each an ordered window like the action's: before range,
  determine range (maneuvers), before strikes, strikes (each combatant chooses; a hand strike by
  default, zero-vtes 4.3), strike resolution with damage and prevention (the preventer chooses
  which points go unprevented, 4.2), damage applied (blood to mend, torpor or burning for
  vampires; life for allies), presses, end of round, and the after-combat window (4.1). Additional
  strikes come after the normal pair (47.2). A combatant no longer ready plays end-of-round cards
  only (4.5).
- **Commands**: `ChooseRange`, `ChooseStrike{kind, damage?, ...}`, `Prevent{points}`,
  `Press{continue|end}`, with overrides for anything a card changes.
- **Web**: the combat panel with the current step, both combatants, and the choices.
- **Tests**: scenarios for a plain fight, ranged combat, prevention, presses, torpor, an ally
  burned; property tests extended to combat.

### M6.5 Referendums

- **Engine**: after a successful political action, terms (by the acting Methuselah), then the
  polling window (architecture §4.3: commitments, no priority holder, closed by a full rotation of
  passes), with the ordered "before votes and ballots" window first (zero-vtes 64.12); votes
  declared per source (Q5), the calling card's vote (5.4), the Edge; the tally and the
  after-resolution window (5.8). A political action whose vampire is no longer ready has no
  referendum (5.9). Blood hunts use the same machinery.
- **Web**: the referendum panel: the terms, everyone's declared votes, casting and passing.
- **Tests**: scenarios for passing, failing, tied, the Edge, a title, a card played during
  polling reopening responses (5.3), a blood hunt.

### M6.6 Spectators and the finished game (GAME-16)

- A finished game stays viewable as it ended, with its result and log; the lobby lists recent
  results; spectators see the final standings live.

## M5b leftovers folded in

- **Mentions by current name**: seats record the player's display name at the start and on a
  replacement, and mentions match it (M5b review).
- **Judge queue filters**: claimed or unclaimed, tournament or casual (M5b.4 plan).
- **Trigger tests**: deadline reminders, being ousted, block decisions (M5b.5 plan).
- **Digest times**: a time zone on the Account page, so digests arrive at 17:00 local.

## Order and size

| # | Increment | Depends on | Rough size |
|---|---|---|---|
| 1 | Game end and scoring | — | 2–3 days |
| 2 | Withdrawal | 1 | 1–2 days |
| 3 | Results and stats | 1 | 2–3 days |
| 4 | Combat steps | — | 4–6 days |
| 5 | Referendums | — | 3–4 days |
| 6 | Spectators and the finished game | 1 | 1 day |
| — | M5b leftovers | — | 1–2 days, alongside |

1 first, as it fixes the beta bug and everything else reads its result. 4 and 5 are independent
and the largest; they could go either way.

## Docs to update as each lands

`docs/flow.md` (game end, withdrawal, combat steps, referendums), `docs/console.md` (new commands
and scenario expectations: `result`, `gw`, `withdrawing`, combat and polling steps),
`docs/02-architecture.md` (§4.4, §5.3 store keys, §5.8 stats), `docs/testing.md` (new properties),
and `docs/roles.md` whenever a role gains or loses a power (every milestone, from now on).

## Later (noted, not in M6)

- **Turn limits the engine doesn't enforce yet**: hand size (and the cards that change it), the
  influence phase's transfer limit, and one master phase action a turn. When hand size is
  enforced, withdrawal's "less than a full hand" (M6.2) uses it instead of 7.
- Card-specific automation (GAME-14).
- Replays of finished games from their event log (GAME-17).
- Tournament results, standings and the archon export: with tournaments, M7.
