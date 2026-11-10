# Command console

The console (GAME-13) is a secondary, opt-in text panel for changing the game when the table UI or
automation can't handle a situation. Each line becomes the same engine command the UI would send,
so it follows the same permissions (GAME-10), appears in the game log and is visible to every
player. The parser lives in `packages/engine/src/console` and is shared by every client.

## Commands

| Command | Effect |
|---|---|
| `draw [n]` | Draw `n` (default 1) cards from your library into your hand |
| `draw crypt [n]` | Draw from your crypt into your uncontrolled region |
| `move <card> <zone> [top\|bottom] [facedown\|faceup]` | Move a card. Library and crypt default to the top; other zones to the end |
| `lock <card>` / `unlock <card>` | Lock or unlock |
| `contest <card>` / `uncontest <card>` | Mark as contested or not |
| `flip <card>` | Turn a card in play face down or face up |
| `blood <±n> <card>` | Add or remove blood counters |
| `life <±n> <card>` | Add or remove life counters |
| `counter <±n> <card>` | Add or remove generic counters |
| `transfer <±n> <card>` | `+n` moves blood from your pool to the card, `-n` from the card to your pool |
| `pool <±n> [seat]` | Change a pool (default: yours) |
| `vp <±n> [seat]` | Change victory points; halves allowed (`vp +0.5`) |
| `shuffle [zone]` | Shuffle your library (default), crypt or hand |
| `attach <card> <host>` | Attach a card to a minion in play, moving it there if needed |
| `detach <card>` | Detach a card, leaving it where it is |
| `reveal <card>` | Show one of your hidden cards to everyone |
| `edge <seat\|none>` | Give the Edge to a seat, or to nobody |
| `direction prey\|predator` | Which way play passes when a turn ends (GAME-20) |
| `next` | End the current phase (or the turn, after discard). Opens the end-of-phase pass round unless every other player auto-passes it |
| `autopass all\|none\|<phase>,…` | Which end-of-phase pass rounds you pass automatically (default: all) |
| `stop none\|neighbours\|anyone` | Block windows you never pass automatically, even when you can't block: none (default), actions by your prey or predator, or every action |
| `hold` | Ask the open window to wait for you; you won't pass automatically until you pass |
| `bleed <minion> [seat] [with <card>] [via <card>\|override]` | Declare a bleed; the target defaults to your prey. Locks the minion and opens the block window. Bleeding anyone else needs a card effect: an action card tagged for it, `via` the card in play that allows it, or `override` to claim one without naming it (casual games; with `with`, the action card is the source) |
| `hunt <minion> [with <card>]` | Declare a hunt |
| `political <minion> [with <card>]` | Declare a political action |
| `equip\|recruit\|employ <minion> with <card>` | Declare an equip, recruit or employ action with a card from your hand. On success the card goes into play (equipment attached to the minion) |
| `action <minion> [seat] [with <card>]` | Declare any other action, directed at a seat or not |
| `block <minion> [via <card>\|override]` | Try to block the current action (needs the impulse; you must be the target, or prey or predator for undirected actions). Otherwise name the card effect that allows it: `via` a card in your hand (played with the attempt) or in play, or `override` without a card (casual games) |
| `unblock` | Withdraw your block attempt |
| `pass` | Pass the impulse. With no block attempt pending, an eligible blocker's pass declines to block |
| `play <card> [ready] [on <host>] [noreplace]` | Play a card from your hand: to the ash heap, into your ready region, or attached to a minion. It is replaced from your library unless `noreplace`. In a window it needs the impulse and returns it to the acting player |
| `resolve success\|failure [n] [edge]` | Resolve your unblocked action. A successful bleed takes `n` (default 1) pool from the target and, with `edge`, gives you the Edge; a successful hunt adds `n` blood, up to capacity |
| `resolve combat <minion>` | Your unblocked action enters combat: your acting minion fights that minion |
| `maneuver long\|close [via <card>]` | In the range step of a combat: change the range. `via` names the card it comes from: in your hand (played with it) or in play |
| `strike hand [n]` · `strike <n>[R][A]` · `strike dodge` · `strike ends` · `strike steal <n>` · `strike other "text"` · `strike none`, then `[first] [via <card>]` | In the strike step: choose your strike. `2R` is 2 ranged damage, `2A` aggravated, `2RA` both; `ends` is a combat-ends strike; `first` marks a first strike. The acting minion chooses first |
| `prevent <n> [via <card>]` | In the damage step: prevent damage your minion is about to take |
| `strike extra [via <card>]` | In the damage step: take an additional strike, after this exchange |
| `press continue\|end [via <card>]` | In the press step: press to continue the combat, or to end it |
| `pass strikes` / `pass round` | In combat: pass every step up to the strikes, or to the end of the round, unless the other combatant does something first |
| `use <card> ["what it does"]` | Use an ability of one of your face-up cards in play: logged for the table, with the combat step if in one. In a window it needs the impulse |
| `endcombat` | End the combat at once, in any step; a blocked action counts as blocked |
| `cancel` | Cancel your action (an override; nothing else happens) |
| `look <card>` | **Judges**: look at a hidden card. Every player sees that it happened |
| `replace <seat> <user>` | **Admins**, non-tournament games: hand a seat to another player (GAME-19) |

## References

- **Cards**
  - A name, in quotes if it has spaces: `"Ilse Várga"`. Matching ignores case, accents and
    punctuation, and tries an exact match, then a prefix, then any substring. It only ever matches
    cards you can see, and prefers your own. Identical copies in the same place are
    interchangeable; otherwise you're asked to be more specific.
  - A position, counted from the top (1 = top card): `hand:2`, `ready:1`, or another seat's zone
    with `B:ready:1`.
  - An instance ID, or a unique prefix of one: `#7k3m`.
- **Seats**: the seat ID, the player's name, `me`, `prey` or `predator`.
- **Zones**:
  - `crypt`, `library` (`lib`), `hand`, `uncontrolled` (`unc`), `ready`, `torpor`, `ash`,
    `removed` (`rfg`), `research`.
  - Prefix a seat to pick another seat's zone: `B:ready`.
  - Without a prefix, cards return to their **owner's** library, crypt, hand, ash heap and
    removal area, and stay with their **controller** for ready, torpor and research.

## Scenarios

Golden scenarios in `packages/engine/scenarios/*.scenario` are scripted games written in console
syntax. The TypeScript tests run them, and the Swift client will run the same files through
JavaScriptCore. They use an invented card catalog (`catalog.json`), since real card data is never
committed (LEGAL-08).

Scenarios in `scenarios/real-cards/` use real cards, named by VEKN ID only (`crypt A 200107 *3`),
so the files still carry no card data. Commands refer to cards by position (`A:hand:3`), which the
seed fixes. They run in the tests when a local content pack exists (`pnpm content:ingest`), and
the web app's **Replay** page (behind the `replay` flag, on locally) plays them on the real table:
step forward and back, watch from any seat, the judge, a spectator or everything, and play on from
any step.

### Writing a Replay scenario

1. **Start from a real example** where you can: the rulebook's worked examples, or a ruling
   (`CLAUDE.md`). Many of the rulebook's examples name real cards (Chrysanthemum, Underbridge Stray,
   Wauneka, Flávio Gonçalves…).
2. **Build it in the sandbox**, on the real cards: `pnpm sandbox --real`, or
   `pnpm sandbox --real --scenario packages/engine/scenarios/real-cards/05-combat-with-cards.scenario`
   to start from an existing one. `.find magnum` lists card IDs for the deck lines (`.44 Magnum` is
   `100001`). Type commands as any seat (`.as B`), look at the table (`.view`: hands with
   positions), take one back with `.undo`, and `.save my.scenario` writes the session.
3. **Keep positions predictable**: a deck of one card (`library A 100001 *40`), or a few, makes
   `A:hand:1` easy to know; the seed fixes the rest. Name cards by position or ID in commands,
   never by name, so the file carries no card data (LEGAL-08).
4. **Tidy it up**: the first sentence of the opening comment is the summary on the Replay page,
   the file name its title (`05-combat-with-cards` → "Combat with cards"). Add `#` comments to say what each part shows
   (the Replay page shows them beside the script), and `expect` and `log` lines to pin what should
   happen.
5. **Save it** as `packages/engine/scenarios/real-cards/NN-name.scenario`. The engine tests run it
   (`pnpm --filter @torn-signpost/engine test`). A running `pnpm dev:web` picks a new file up when
   restarted.

```text
# comment
seed 7                         # deterministic shuffles
format standard|v5|duel
tournament                     # mark the game as a tournament game (2 h timer unless set)
timelimit 2h                   # the table timer; deadline 24h: time per decision while away
seat A alice                   # seats in clockwise order
crypt A "Vera Nightfall" *12   # deck lists by name or card ID; *n repeats the previous card
library A "Iron Ward" *40
start

A> draw crypt 4                # a command by seat A's player; also judge> and admin>
present B no                   # the server records B's player as away (yes: at the table)
wait 13h                       # time passes; due checks (deadlines, time limit, pause end) run
A> pause 3                     # pause a timed game for 1–5 minutes; resume lifts it early
admin> endgame "Venue closing" # an admin ends the game, scored as a timeout (½ VP to each survivor)
A> propose                     # casual games: propose ending early; `agree` / `decline` answer it
A> withdraw                    # your unlock phase, empty library, short hand: leave next turn, ½ VP
B> call rules Does it stack?   # call a judge: slow-play|rules|dispute|other [seat] [note]
judge> claim                   # judges take the oldest call (or claim c42); judge2> is another judge
judge> rule passfor B          # answered|escalate|extend B 12|passfor B|time 10|disqualify B [note]
reject A> look A:library:1     # the command must fail; reject:<code> pins the rejection code

expect pool A 30
expect vp A 1.5
expect edge A|none
expect ousted B true|false
expect present B yes|no
expect tempo live|async        # live while every Methuselah still in the game is present
expect waiting B:block         # who the game waits on and why (seat:kind, space-separated), or none
expect elapsed 30m             # table clock, whole minutes played while live
expect paused yes|no
expect status active|finished  # the game's status
expect ended <reason>|no       # last-standing, no-survivors, time-limit, judge or agreement
expect winner A|none           # the most VP alone, ousted or not
expect gamewin A|none          # a winner with at least 2 VP
expect withdrawing A yes|no    # a withdrawal announced and still holding
expect withdrawn A yes|no      # out of the game by withdrawing
expect timeup yes|no           # the time limit was reached
expect deadline A pending      # an away player's deadline: none, pending, reminded or expired
expect calls rules:B@judge     # open judge calls: reason[:about][@claimed by], or none
expect disqualified D true
expect direction prey|predator
expect turn 2 B unlock
expect occupant B erin
expect count A:hand 7          # cards in a zone
expect sees B A:hand 0         # how many cards in a zone the viewer can identify (seat, judge, public)
expect impulse B               # who holds the impulse, or none
expect action bleed A blocks   # kind, acting seat, stage (blocks, combat, resolution), or none
expect combat 1 range long     # round, step and range of the combat, or none
expect window phase master     # open window kind and phase, or none
expect autopass B none         # phases a seat auto-passes, comma-separated, or none
expect holds C                 # seats holding the open window, comma-separated, or none
expect card A:ready:1 blood 7  # zone, controller, owner, locked, faceDown, contested,
                               # blood, life, generic, attached (a host name or card ref)
log B A drew 7 cards from their library   # a log line, as the given viewer reads it
```
