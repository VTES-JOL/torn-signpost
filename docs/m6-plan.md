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
| Referendums | Nothing: a political action is resolved by hand | Terms, the polling window, votes and ballots, the tally, blood hunts (M6.5) |
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
| Q4 | How far does combat go? | GAME-07 is a "should"; zero-vtes batches 4, 21, 22, 29 | **Guided steps** (range, strikes chosen each round, damage, prevention, presses, torpor), with card effects by hand. No card-specific automation. **Settled (2026-11-06)**: each step a window, like the phases; see M6.4 |
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

### M6.4 Combat steps (GAME-07): done

Combat runs like the phases: a window for each step of the round, with the two combatants
passing in priority order. The engine keeps track of the mechanics (round, step, range, strikes,
damage); which card may be played in which step is left to the players, as everywhere else, and
shown to the table in the log.

**Today:** a successful block moves the action to `combat`, which waits on both players until
either sends `EndCombat`. Everything in between is done by hand with the free-form commands.

**Decisions** (2026-11-06, from the user's design):

- **C1 Steps are windows.** Each round goes Before range → Range → Before strikes → Strikes →
  Damage → Press → End of round (the rulebook's combat sequence). Each is a `combat` window
  holding the acting minion's controller, then the opposing minion's (the acting minion has the
  first opportunity at every step). Anything done in a step returns the impulse to the acting side,
  as the rulebook's "Impulse" has it, and resets the passes; two passes in a row end the step and
  open the next. (Until the rulings check after M6.4b, a play handed the impulse to the other
  combatant.)
- **C2 Only the two combatants are in the windows.** Other players can still `hold` and use the
  free-form commands. Combat windows ignore auto-pass settings: a combatant passes by hand, or
  with C6.
- **C3 Card timing isn't enforced, but every move is in context.** Every log line in combat names
  the round and step ("Round 1 · Before strikes: Beast plays Immortal Grapple"), so the table can
  see what was played when, and a judge can be called on it.
- **C4 Every combat move can name a source.** A card in hand is played as `play` would play it
  (ash heap, or wherever it goes, and replaced); a card in play (a weapon, equipment, the minion
  itself) is only referenced. Same `via` as `block` today. A hand strike needs none.
- **C5 The engine applies the damage** when the Damage step closes, from the strikes and
  preventions declared: vampires mend normal damage with blood, unmended damage sends them to
  torpor, aggravated damage on a wounded vampire burns blood or burns the vampire; allies lose
  life and burn at 0. Mistakes are fixed with the usual commands.
- **C6 Pass to strikes.** A combatant can pass every step up to Strikes in one go (and, from
  Damage, up to the end of the round). The standing pass is dropped as soon as the other combatant
  does anything in between, so they never miss a response.

**State:** the action at `combat` gains `combat { round, step, range: 'close'|'long', acting,
opposing, lastManeuver?, strikes, pending?, press?, passUntil? }`; `ImpulseWindow.kind` gains
`combat` (with its `step`). An action already at `combat` without it (games from before this)
keeps today's behaviour: `EndCombat` only.

**Commands** (engine, then console):

| Engine | Console | Checks and effect |
|---|---|---|
| `Maneuver { to, source? }` | `maneuver long\|close [via <card>]` | Range step, the sender's combatant. Refused if the range is already `to`. Sets the range and who maneuvered last. "Theo Bell maneuvers to long using .44 Magnum" |
| `Strike { kind, damage?, ranged?, aggravated?, first?, source?, note? }` | `strike hand [n]` · `strike 2R via ".44 Magnum"` · `strike dodge [via <card>]` · `strike ends via <card>` · `strike steal <n> via <card>` · `strike none` · flags `first`, `A` in the damage (`2A`, `2RA`) | Strikes step: the acting combatant announces first, then the opposing one, so each sees what they face. Kinds `hand`, `damage` (from a card or weapon), `dodge`, `combat-ends`, `steal-blood`, `other` (with a note), `none`. A strike without R at long range is shown as having no effect and does nothing. "Theo Bell strikes with .44 Magnum for 2R damage" |
| `Prevent { points, source? }` | `prevent <n> [via <card>]` | Damage step: reduces the damage pending against the sender's combatant, in the order played. "Beast prevents 1 with Skin of Rock" |
| `Press { mode, source? }` | `press continue\|end [via <card>]` | Press step. A press to end cancels a press to continue. "Theo Bell presses to continue with Pursuit" |
| `UseCard { card, note? }` | `use <card> ["note"]` | Uses an ability of a card in play, anywhere in the game, not only in combat: "Theo Bell uses .44 Magnum: +1 strength". Logged; nothing else happens |
| `PassUntil { step }` | `pass strikes` · `pass round` | C6 |
| `PlayCard`, `Pass`, `EndCombat` | `play`, `pass`, `endcombat` | As now, with the step in the log. `EndCombat` stays the escape hatch: either combatant or a judge ends the combat at once |

**How a round resolves:**

- Strikes closes once both have announced (they can still `play` and `use` around that).
- Damage pending is worked out from the strikes: Combat ends first (combat ends, End of round
  follows), then first strikes, then the rest; a dodge cancels the other strike's effect on the
  dodger; steal blood moves blood and isn't damage. With a first strike, Damage runs for first
  strikes, then again for normal ones if the striker is still ready.
- When Damage closes, C5 applies the damage, normal before aggravated. A combatant no longer
  ready (torpor, burned) ends the combat after End of round.
- **Additional strikes**: in Damage, a combatant can announce one (`strike … extra`, with a
  source); after the damage is applied, Strikes and Damage run again for the additional strikes
  only, at the same range, without the steps before.
- Press closes with a press to continue standing → round 2 from Before range; otherwise End of
  round, then the combat ends and the action ends as blocked.

**Starting combat other ways:** an unblocked action can end in combat ("enter combat" actions):
`ResolveAction { outcome: 'combat', opponent }` (`resolve combat <minion>`) starts it with the
acting minion against that minion, without ending the action first. Combat started by card
effects outside an action stays by hand for now.

**Who the game waits on:** `waitingOn` in combat is the combatant holding the impulse, kind
`combat`, so deadlines, notifications and the status bar work as for other windows.

**Web:** a combat panel in place of the flow bar: the step track (current step lit), round and
range; both combatants with blood or life, the strikes announced and the damage pending; the
buttons for the step (Maneuver…, Strike…, Prevent…, Press…, Play a card, Use a card…, Pass, Pass
to strikes). Each source picker lists the hand, then the minion and its cards in play. **Use a
card…** is also in the card menu of every card in play.

**Split:**

- **M6.4a** (2–3 days), **done**: the steps and windows (C1, C2, C6), Maneuver, Strike (announced, not yet
  applied), UseCard, the round and step in the log (C3), `resolve combat`, the combat panel.
  Damage, Press and End of round are plain windows; the combatants adjust blood by hand.
- **M6.4b** (2–3 days), **done**: damage pending and applied (C5), Prevent, first strike, dodge, combat
  ends, steal blood, additional strikes, presses and later rounds, torpor and burning ending the
  combat.

**Tests:**

- Engine: each step's window order and closing; responses resetting passes; the range and last
  maneuver; strike order (acting first); a strike without R at long range; pass to strikes
  dropped when the other combatant acts; old games at `combat` keeping `EndCombat`.
- Scenarios (`.scenario` files through the console): a plain hand-strike fight; a maneuver war
  with a gun; Immortal Grapple before strikes; prevention; aggravated damage burning a wounded
  vampire; an ally burned; a press to continue answered by a press to end; additional strikes;
  first strike sending the other to torpor before it strikes; combat ends.
- Properties: a combat always ends; the game never waits on nobody; damage applied never takes
  blood or life below 0.
- Browser: two players fight a round through the panel, the spectator sees each step in the log.
- Docs: `docs/flow.md` (the combat steps, commands and lifecycle), `docs/console.md` (the new
  commands), architecture §4.3–4.4, `docs/roles.md` if a role's powers change (none planned:
  judges can already end combat).

**Later:** diablerie (with torpor's rescue and leave actions), card-specific combat effects
(GAME-14), combat outside an action.

### M6.5 Referendums

The engine runs the referendum's steps and keeps the count; what a passed referendum does is
applied by the players with the usual commands, as for every card effect (decision 4).

**Today:** a political action resolves like any other: `resolve success`, and the players count
the votes at the table and apply the effects by hand.

**Rules** (rulebook, "Politics"; zero-vtes rulings as numbered):

- A successful political action calls a referendum: the terms are chosen (only now, not when the
  action is announced), then the polling step, then the tally. More votes for than against passes
  it; a tie fails (rulebook).
- A political action whose acting vampire is no longer ready when it succeeds has no referendum
  (5.9); it still ends successful.
- The polling step opens with the cards usable "before votes and ballots are cast": the other
  Methuselahs first, from the caller's left, the caller last (64.12). Then votes are cast.
- Votes come from sources (1.1). A vampire is one source: all its votes at once, all on one side,
  and only while it is ready (rulebook). Votes it gains after casting join its cast on the same
  side (5.1, 19.3). The Methuselah's own votes are separate sources, each either way: the Edge
  (burned for 1 vote), a political action card (1 vote, burned; one per Methuselah per
  referendum), and other cards that grant votes.
- The calling political action card is the caller's 1 vote, either way, and their one political
  action card vote: they can't burn another (5.4, 46.2).
- Titles give votes while the vampire is ready: primogen and bishop 1, prince, baron, archbishop
  and magaji 2, justicar and cardinal 3, Inner Circle and regent 4; "n votes (titled)" n
  (rulebook, "Titled Vampires" and "Other Vampire Sects"). Prisci share a block of 3 votes by a
  sub-referendum of ballots (52.9).
- A cast can't be changed. Every commitment, a card played included, gives every other
  Methuselah another chance to respond before the tally (5.3).
- After the referendum, the action ends successful, passed or not, and the political action card
  is burned (5.8).

**Decisions:**

- **R1 Terms when it succeeds.** `resolve success` on a political action takes the terms as text
  (`resolve success "gain 3 pool"`) and calls the referendum, instead of ending the action. The
  engine doesn't read the terms; they're in the log and on the panel.
- **R2 Two windows.** First an ordered `referendum` window for the cards played before votes:
  from the caller's prey round the table, the caller last, with the usual auto-pass, holds and
  stops (the minion phase's setting). Then the `polling` window, from the caller round the table.
- **R3 Polling is a rotation of commitments.** The seat holding the polling impulse casts any
  number of sources, plays or uses cards, then passes. Anything it does sets the pass count back
  to zero but keeps the impulse with it (no return to the caller: architecture §4.4), so the
  window closes only after a full round of passes with nothing done.
- **R4 Everyone passes polling by hand**, whatever their auto-pass setting: votes matter, and
  the engine can't tell who holds a political action card. To keep async games moving, a
  Methuselah can `abstain`: pass every polling turn for the rest of this referendum, casting
  nothing more. Holding the Edge, or a vampire not yet cast, is shown on the panel so nobody
  forgets them.
- **R5 Declared votes, checked where the engine can.** `CastVotes` names a source and a side:
  - a ready vampire you control: its title's votes by default; another number may be claimed
    (title cards, vote bonuses) and the log shows it as claimed, as overrides are;
  - `edge`: you hold the Edge; it is burned for 1 vote;
  - `card`: the calling card's vote, the caller's only;
  - a political action card in your hand: burned (and replaced) for 1 vote; one per Methuselah,
    never the caller with a calling card;
  - `other n [via <card>] ["note"]`: votes from any other source; a card from the hand is played.
  A vampire already cast can only add votes on the same side.
- **R6 The tally closes it.** When polling closes, the engine counts, logs "The referendum passes
  (5 for, 2 against)" and ends the action successful; the political action card goes to the ash
  heap. The caller then applies what passed by hand.
- **R7 Escape hatches.** `CancelAction` still ends everything; `endreferendum pass|fail` settles
  the referendum at once, for cards that do (Yoruba Shrine 35.4, Fakir al Sidi 59.18, Día de los
  Muertos 52.3). Either is open to the caller and to judges.

**State:** `ActionState.referendum { terms?, votes: Cast[], pacUsed: SeatId[], abstaining? }` with
`Cast { seat, source: 'vampire'|'edge'|'card'|'burned'|'other', minion?, card?, cardId?, side,
votes, claimed? }`; `ImpulseWindow.kind` gains `referendum` and `polling`; `ActionEnded` stays
`success`, after a `ReferendumResolved { passed, for, against }`.

**Commands** (engine, then console):

| Engine | Console | Checks and effect |
|---|---|---|
| `ResolveAction { outcome: 'success', terms? }` | `resolve success ["terms"]` | On a political action: calls the referendum (R1), or ends it with none if the vampire isn't ready (5.9) |
| `CastVotes { source, side, minion?, card?, votes?, note? }` | `vote for\|against <vampire> [n]` · `vote for edge` · `vote for card` · `vote for <card in hand>` · `vote against other 2 via "Ventrue Headquarters"` | R5, in the polling window, on your impulse |
| `Abstain` | `abstain` | R4 |
| `EndReferendum { passed }` | `endreferendum pass\|fail ["why"]` | R7 |
| `PlayCard`, `UseCard`, `Pass`, `Hold` | as now | In both windows; in polling, R3 |

**Who the game waits on:** the impulse holder, kind `impulse` in the before-votes window and
`vote` in polling.

**Web:** a referendum panel in place of the flow bar, like combat's: the terms, the running count
for and against, each cast (who, which source, how many, which side), and the uncast sources of
the player (ready titled vampires, the Edge, the calling card). The offers: Vote for…, Vote
against… (choosing the source, with the title's votes filled in), Play a card, Use a card…, Pass,
Abstain.

**Split:**

- **M6.5a** (2 days), **done**: R1–R6 for political actions: the windows, casting from vampires, the
  Edge, the calling card, a burned political action card and other sources; abstaining; the tally;
  the panel.
- **M6.5b** (1–2 days), **done**: R7; blood hunts (a referendum that isn't an action, with no before-votes
  window and no action modifiers or reactions; called by hand until diablerie comes); the prisci
  block's ballots; making a vampire abstain (Kateline Nadasdy 76.6, Demonstration 77.14).

**Tests:**

- Engine: the before-votes order (caller last) and the polling order; a commitment resetting the
  passes and keeping the impulse; abstaining; one cast per vampire, adding on the same side only;
  the Edge burned; the calling card's vote the caller's only, and no second card vote for them; a
  political action card burned and replaced; not ready → no referendum; ties failing; an ousted
  seat leaving the polling.
- Scenarios, from the rulebook and rulings: a prince and a primogen pass a referendum against an
  archbishop (title votes); a tie fails; the Edge and a burned card decide it; the caller can't
  burn a second card (46.2); a vote cast after a card played in polling (5.3); a vampire sent to
  torpor before it succeeds (5.9).
- Properties: a referendum always ends; votes cast never change side; the game never waits on
  nobody.

### M6.6 Spectators and the finished game (GAME-16): done

**Already in place** (M6.1, M6.3): a finished game refuses commands, stops its timers, deadlines
and judge calls, and shows the Game over panel to everyone watching, spectators and guests
included, pushed live as it ends; its table and log stay viewable; counted games have results on
players' pages.

**Gaps found while planning:**

- The lobby never shows finished games: the web asks only for open, active and "mine", and the
  finished lobby index is sorted by when a game was *created*, not when it ended.
- A game summary carries no result, so a list of games can't say who won.
- A player's page links every counted game to its table, but a private game's table is 404 for
  everyone outside it, while its result is meant to be public (S1).
- A finished table still reads as live for its players: "you are seat A", their hand, the console
  input, and a flow bar with nothing to wait on.
- Nothing tests a spectator seeing the end live.

**Decisions** (recommendations; F1–F4 below):

- **F1 Hidden information stays hidden after the end.** Hands, libraries and face-down cards are
  never revealed by the game ending, to spectators or players: GAME-16 says public information
  only, and decks are only shown when public (S5). Judges and admins still see what they see now.
- **F2 A private counted game's result is public; its table isn't.** Anyone can open the result
  (standings, VP, who won, how each seat finished, end reason, players' links); the table, log
  and chat stay with its players, judges and admins.
- **F3 Chat stays open after the end** for the players and judges, for "gg" and rulings talk; no
  time limit for now.
- **F4 The lobby's "Recent results" lists every public finished game**, newest ended first (the
  last 20), counted or not, with the winner and a "counted" mark on the ones that count. Private
  games appear only in their players' own lists, as now.

**Backend:**

- At the end, the game meta gains `ended {at, reason, winner?, gameWin?, standings[{seat, name,
  vp, finish}]}`, written in the same append that sets `status: 'finished'`, and the finished
  lobby index is keyed by the end time (`GSI1SK = ended.at`). `GameSummary` gains `ended`.
- `GET /games?status=finished` returns the last 20.
- `GET /games/:id/result`: the result of a counted game (the `RESULT` item) to anyone; for a game
  that doesn't count, the same to those who can view the game, else 404.
- `stats:rebuild` also backfills `ended` and the index key on games finished before this ships.

**Web:**

- Games page: a "Recent results" list under the running games: name, format, end time, winner
  (with a game win marked), each player's VP.
- Finished table: the title reads "finished · you were seat A" (or "spectating"); the Game over
  panel sits at the top; no hand toolbar or console input (the console still reads, with
  "The game is over" on input); the flow bar says the game is over and why.
- A result page at `/games/:id/result` (the Game over panel, standalone), used for a private
  game's link on a player's page, and where `/games/:id` sends someone who can't view a private
  counted game.

**Tests:**

- Integration: `ended` and the index order; the finished list newest ended first; the result
  route for a private counted game (anyone), a private uncounted one (404 outside it), a public
  one; the rebuild backfilling `ended`.
- Browser: a guest watching a public game sees Game over appear live when an admin ends it, then
  finds it under "Recent results"; a player of a finished game sees no toolbar, hand actions or
  console input; a stranger opening a private counted game from a player's page gets its result.
- Docs: `docs/roles.md` (anyone can see a counted game's result, F2; chat after the end, F3),
  architecture §5.3 (the meta's `ended`, the finished index key) and §4.4.

### M6.7 Checked against zero-vtes (2026-11-12)

The engine was compared with zero-vtes at `1f33be5` (Protocol 2.27.0): its rules digest
(`docs/rules-digest.md`, the rulings arranged by mechanism) and rules-qa up to Batch 115. Only what
both engines model was compared (zero-vtes also automates every card). Ousting and its rewards,
game wins, withdrawal, bleeds and the Edge, the block loop and referendums matched; none of the
rules-qa items cited here had been revised.

Done in this increment:

- **Leaving torpor** (rulebook, "Leave Torpor", "Torpor"): a vampire in torpor could take no
  action at all. It now takes the leave-torpor action, undirected, 2 blood on success; blocked,
  there's no combat: a blocking vampire's Methuselah may diablerize it (`Diablerize`, the blood
  hunt following at once) or not, and an ally's block simply fails it. Scenario 24.
- **Changing blockers** (rules-qa 48.3, 114.1, settled by zero-vtes's owner on 2026-11-11): the
  Methuselah whose attempt is under way may attempt with another minion, which fails the first.
- **The would-be-successful window** (digest §5.2, §10.1; rules-qa 24.2, 54.1): a bleed or political
  action nobody blocks opens it, over the action's order, before it resolves; none once it has
  failed, or for a bleed of 0.
- **The after-resolution window** (§5.2, §10.4; rules-qa 5.8, 23.3, 24.1): every action that
  succeeds, fails or is blocked has one (`ActionConcluded`, stage `after`), after a political
  action's referendum and a diablerie's blood hunt; not a cancelled one. The acting Methuselah's
  next move (resolving; the next action or the end of the phase) passes each window when nobody
  else would stop it, so neither costs a click on every action. Scenarios 25 and real-cards 11.
- **The acting minion leaving** (rulebook, "Resolve the Action"; digest §24.3): leaving the ready
  region before blocks are resolved ends the action (`minion-gone`), the blocker not locked, with
  no after-resolution window (§3.2). Scenario 26.
- **`EndCombat` and the end of round** (rules-qa 19.5): a combat ended early goes to End of round,
  no strike resolving; its window still opens. Scenario 26.

Still to do, in rough order:

1. **Combat for everyone else** (§12.1; rules-qa 98.1, 98.2): after the two combatants, every
   other Methuselah clockwise from the acting one has the impulse in each step, for cards that
   reach a combat they're not in. Today only the combatants' Methuselahs do.
2. Smaller: withdrawal's short hand read as the turn began (95.3); no polling-step cards in a
   blood hunt (PIB 20150105).
3. **Rescue and diablerie as actions** of their own (rulebook, "Rescue a Vampire from Torpor",
   "Diablerise a Vampire in Torpor"): today an `other` action with the players' moves, and
   `CallBloodHunt`.

Process: cite zero-vtes with the commit it was checked at, and start each rules feature from the
digest's section for that mechanism, not only rules-qa.

## M5b leftovers folded in: done

- **Mentions by current name**: the game records each player's display name at the start and a
  replacement's when they take their seat (in the game's players, not the event log, which keeps
  only user IDs for account deletion); mentions match it and reach only the seats' current
  players (M5b review). This also fixed a replacement showing as a user ID at the table.
- **Judge queue filters**: claimed or unclaimed (mine, other judges'), tournament or casual,
  alongside the reason (M5b.4 plan).
- **Trigger tests**: deadline reminders, being ousted, block decisions (M5b.5 plan).
- **Digest times**: a time zone on the Account page, so digests arrive at 17:00 local. The digest
  now runs hourly and sends each user's when it's due in their zone.

## Order and size

| # | Increment | Depends on | Rough size |
|---|---|---|---|
| 1 | Game end and scoring | — | 2–3 days |
| 2 | Withdrawal | 1 | 1–2 days |
| 3 | Results and stats | 1 | 2–3 days |
| 4 | Combat steps (4a steps and strikes, 4b damage and presses) | — | 4–6 days |
| 5 | Referendums | — | 3–4 days |
| 6 | Spectators and the finished game | 1 | 1–1½ days |
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
- **Other rules left to the players** (found checking the commands against the rulebook,
  scenarios 20 and 21): the first turns' 1, 2 and 3 transfers and the transfer costs; the Edge's
  pool in the unlock phase; one bleed and one political action per minion a turn, and the same
  action card or card in play once a turn; a ready vampire with no blood must hunt; allies don't
  hunt or take political actions, and can't act the turn they're recruited; stealth and
  intercept; one discard phase action; unique cards and contests.
- Card-specific automation (GAME-14).
- Replays of finished games from their event log (GAME-17).
- Tournament results, standings and the archon export: with tournaments, M7.
