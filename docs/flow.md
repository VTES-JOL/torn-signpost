# Structured flow: phases, actions and windows

What the engine offers a player at each point of a turn, and what it checks before accepting a
command. This is a reference for the current implementation (M5a). The design behind it is in
[architecture §4.3–4.4](02-architecture.md#43-available-actions--what-drives-the-toolbar-ux-03).

| Concern | Code |
|---|---|
| Offers shown in the toolbar and context menus | `packages/engine/src/offers.ts` (`availableActions`) |
| Command validation and the events each command produces | `packages/engine/src/decide.ts` |
| Impulse holder, auto-pass, block eligibility | `packages/engine/src/flow.ts` |
| Window order | `packages/engine/src/seating.ts` (`windowOrder`) |
| State shapes (`ActionState`, `ImpulseWindow`) | `packages/engine/src/model.ts` |

Offers are a convenience: they're computed from the player's redacted view so the client can
show them without a round trip. `decide` checks every command again on its own, so a command sent
outside an offer is still accepted or rejected by the same rules.

Card effects aren't scripted. The engine doesn't check disciplines, costs, card-specific timing or
requirements; "Play a card" lists the whole hand. The free-form tabletop commands (`MoveCard`,
`AdjustPool`, `TransferBlood`, counters, lock/unlock and so on) aren't tied to phases either.

## State

Two pieces of state drive the flow:

- **`action`**: the minion action in progress, if any. It goes through the stages
  `blocks` → `combat` or `resolution`, then ends.
- **`window`**: an open impulse window, if any. Its `kind` is `phase` (the end-of-phase round),
  `blocks` (the block window of an action) or `combat` (a step of a combat round). It holds the seat `order`, the `cursor` (who holds
  the impulse), the number of consecutive `passes`, and the seats that asked it to wait
  (`holds`).

## Who the game waits on

`waitingOn(state)` in `flow.ts` derives it from the state above; prompts, and later deadlines and
notifications, read only this.

| Situation | Waits on | Kind |
|---|---|---|
| A window is open, the impulse holder is an eligible blocker who hasn't declined, no block attempt pending | The impulse holder | `block` |
| Any other open window | The impulse holder | `impulse` |
| An action at `resolution` | The acting Methuselah | `resolve` |
| A combat step is open | The impulse holder | `combat` |
| An action at `combat` with no step open (games from before combat steps) | The acting Methuselah and the blocker's controller | `combat` |
| Otherwise | The acting Methuselah | `phase` |

It's never empty while the game is active and never names a seat that is out. `since` is the event
that started the wait; it restarts when the seat, the kind, the phase or the turn changes, not when
the waited-on player does something within the wait.

## Turn and phases

Phases run `unlock` → `master` → `minion` → `influence` → `discard`, then the next seat's turn
starts at `unlock`. The next seat follows the turn direction, skipping ousted seats.

When a new turn starts, the engine unlocks every locked card in the new acting seat's ready region
and torpor. There's no separate unlock command.

### Ending a phase (`AdvancePhase`)

Offered to the acting player as **End \<phase\> phase**, or **End turn** in the discard phase,
whenever no action and no window is open. It's the highlighted offer when nothing else is.

Checks:
- A turn is in progress.
- The sender is the acting player, or a judge.
- No action is in progress ("Finish the current action first").
- No window is open ("Waiting for the other players to pass"). A judge can still advance, which
  closes the window first; use this to unstick a pass round.

Effect: opens a `phase` window over the other seats so they can play cards out of turn. The
acting player's command counts as their pass. The order is acting seat, prey, predator, then the
remaining seats clockwise. When every seat has passed in a row, the window closes and the phase
advances. If every other seat would pass automatically, the engine skips the window and advances
at once.

## What the toolbar offers

`availableActions` returns nothing unless the game is active and the seat is still in the game.
It then takes the first of these cases that applies.

### 0. A combat step is open

Only the two combatants' Methuselahs get offers ([Combat](#combat)).

| Offer | Shown when | Command |
|---|---|---|
| **Maneuver to long…** / **to close…** | Range step, holding the impulse. Step: the card it comes from (optional), from the hand or in play | `Maneuver { to, source? }` |
| **Hand strike** (highlighted), **Strike with a card…**, **Dodge…**, **Combat ends…**, **Steal blood…**, **No strike** | Strike step, holding the impulse, no strike chosen yet. Strike with a card asks for the card, the damage, its type (normal, R, aggravated, both) and first strike | `Strike` |
| **Play a card** | Holding the impulse, the hand isn't empty | `PlayCard { card }` |
| **Use a card…** | Holding the impulse, with a face-up card in play. Steps: the card, what it does (optional text) | `UseCard` |
| **Pass** (highlighted, except in the strike step) | Holding the impulse; in the strike step, once a strike is chosen | `Pass` |
| **Pass to strikes** / **Pass to the end of the round** | Before the strike step / after it | `PassUntil` |
| **End combat** | Always | `EndCombat` |

An action at `resolution` also offers its Methuselah **Enter combat…**: the minion to fight, from
another Methuselah's ready region (`ResolveAction { outcome: 'combat', opponent }`).

### 1. A window is open

The seat holding the impulse gets the offers below. Every other seat in the window except the
acting Methuselah gets **Hold** (`Hold`), unless it is already holding.

| Offer | Shown when | Command |
|---|---|---|
| **Block** (highlighted) | Block window, no block attempt pending, the seat is eligible and hasn't declined, and it has an unlocked ready minion | `Block { minion }` |
| **Block (card effect)…** | Block window, no block attempt pending, the seat isn't eligible, hasn't declined and isn't acting, and it has an unlocked ready minion. Steps: the card that allows it (a Reaction from the hand or a face-up card in play; optional in casual games), then the blocking minion | `Block { minion, override }` ([Overrides](#overrides)) |
| **Withdraw block** | The seat made the pending block attempt | `WithdrawBlock` |
| **Play a card** | The hand isn't empty | `PlayCard { card }` |
| **Pass**, or **Don't block** when Block is offered | Always | `Pass` |

### 2. An action is in progress, no window open

| Offer | Shown when | Command |
|---|---|---|
| **Successful** (highlighted) | The seat owns the action and it's at `resolution` | `ResolveAction { outcome: 'success', amount?, edge? }` |
| **Unsuccessful** | Same | `ResolveAction { outcome: 'failure' }` |
| **End combat** (highlighted) | The action is at `combat` and the seat is the acting player or controls the blocker | `EndCombat` |
| **Play a card** | The hand isn't empty | `PlayCard { card }` |
| **Cancel action** | The seat owns the action | `CancelAction` |

**Successful** asks for:
- Bleed: the bleed amount (default 1), and whether to take the Edge (on by default unless the
  seat already has it).
- Hunt: the blood gained (default 1).

### 3. No action, no window

| Phase | Acting player | Other players |
|---|---|---|
| Unlock | Play a card · End unlock phase | Play a card |
| Master | Play a master card · End master phase | Play a card |
| Minion | Minion actions (below) · Play a card · End minion phase | Play a card |
| Influence | Play a card · End influence phase | Play a card |
| Discard | Play a card · End turn | Play a card |

- **Play a master card** lists only Master cards in hand. In the master phase the acting player
  isn't offered the general **Play a card**.
- **Play a card** needs a non-empty hand.

### Minion actions

Offered to the acting player in the minion phase, when they have at least one unlocked minion in
their ready region that isn't attached to another card. Every action first asks for the acting
minion from those.

| Offer | Kind | Further steps | Card |
|---|---|---|---|
| **Bleed** (highlighted) | `bleed` | – (always the prey) | Optional Action card |
| **Bleed another Methuselah…** | `bleed` | The card that allows it (a face-up card in play, optional), then the target: any seat but the prey. Not offered when the prey is the only other seat | Optional Action card, which can be the card that allows it |
| **Hunt** | `hunt` | – | – |
| **Political action** | `political` | – | Optional Political Action card |
| **Equip** | `equip` | – | Equipment card; not offered without one |
| **Recruit ally** | `recruit` | – | Ally card; not offered without one |
| **Employ retainer** | `employ` | – | Retainer card; not offered without one |
| **Other action** | `other` | – | Optional Action card |

Card types come from the catalog. When a card has no type data, it counts as every type, so a
minimal catalog still offers everything.

## Commands and checks

### `DeclareAction { kind, minion, target?, card?, override? }`

Checks:
- The sender is the acting player, in the minion phase.
- No action is in progress and no window is open.
- `kind` is a known action kind.
- The minion is the sender's, in their ready region, and unlocked.
- The target, if given, isn't ousted or withdrawn. Targeting your own seat counts as no target.
- A bleed without a target goes to the sender's prey; it's rejected if there's nobody to bleed.
- The action card, if given, is in the sender's hand. It stays there until the action ends.
- A bleed on anyone but the prey needs a card effect; see [Overrides](#overrides).

Effect:
1. Locks the minion.
2. Starts the action at stage `blocks`. The eligible blockers are the target seat for a directed
   action; for an undirected action, prey and predator.
3. Opens a `blocks` window. Its order is the acting seat, then the target (directed) or prey and
   predator (undirected), then the remaining seats clockwise. Declaring counts as the acting
   player's first pass.

### `Pass`

Check: a window is open and the sender holds the impulse.

Effect: the impulse moves to the next seat in the order. In a block window, an eligible seat
that passes while no block attempt is pending has **declined**: it can't block this action any
more.

### `Block { minion, override? }`

Checks:
- A block window is open and the sender holds the impulse.
- The sender isn't the acting player and hasn't declined. A decision not to block stands, whatever
  card effect comes later.
- No block attempt is pending.
- The minion is the sender's, in their ready region.
- A sender that isn't an eligible blocker needs a card effect; see [Overrides](#overrides).

Effect: records the block attempt and returns the impulse to the acting player with the passes
reset, so everyone can respond to the attempt. A source card from the hand is played first: it
goes to the ash heap and is replaced.

### `WithdrawBlock`

Checks: a block attempt is pending and the sender made it (or is a judge).

Effect: removes the attempt and marks the seat as declined. If the sender held the impulse, the
withdrawal also passes it on.

### `PlayCard { card, to?, attachTo?, replace? }`

Checks:
- The card is in the sender's hand.
- It isn't the card of the current action.
- If a window is open, the sender holds the impulse ("Wait for the impulse to play a card").
- If attaching, the host is in play.

Effect: moves the card to the ash heap (or `to`, or the host's zone when attaching), and draws a
replacement unless `replace` is false. If a window is open, the impulse returns to the acting
player and all passes are voided.

### `ResolveAction { outcome, amount?, edge? }`

Checks: the sender owns the action (or is a judge), the action is at `resolution`, and the amount
is a whole number of 0 or more (default 1).

Effect:
- Successful bleed: the target loses that much pool (no more than they have). With `edge`, the
  acting seat takes the Edge if it doesn't already have it.
- Successful hunt: the minion gains that much blood, capped at its capacity when the catalog
  knows it.
- The action card is finished and the action ends.

### `EndCombat`

Checks: the action is at `combat`, and the sender is the acting player, controls the blocker, or
is a judge.

Effect: the action card is finished and the action ends as blocked.

### `CancelAction`

Check: the sender owns the action (or is a judge).

Effect: closes any open window and ends the action as cancelled.

### `SetAutoPass { phases }`

Sets the phases in which the seat passes automatically. All phases is the default.

### `SetStops { stops }`

Replaces the seat's standing stops: situations in which it never passes automatically, whatever
its auto-pass setting. None is the default. Like auto-pass, stops are private to the seat. A stop
fires whatever is in the hand, so it gives nothing away.

| Rule | Fires in |
|---|---|
| `{ on: 'block-window', actors: 'neighbours' }` | Block windows of actions by the seat's prey or predator |
| `{ on: 'block-window', actors: 'anyone' }` | Every block window of another seat's action |

Use a stop to play reactions that let you block actions you can't normally block.

Checks: every rule is known. Duplicates are dropped.

### `Hold`

Asks the open window to wait for the sender: the engine won't pass for it until it passes by hand.
Holding is public; the log reads "C asks the table to wait".

Checks:
- A window is open and the sender is in its order.
- The sender isn't the acting Methuselah (first in the order), who never passes automatically.
- The sender doesn't hold the impulse and isn't already holding.

Effect:
- The seat joins the window's `holds`.
- If the engine already passed for the seat in the current run of passes, that pass is voided:
  the window can't close until the impulse comes round to the seat again, in order. The hold
  doesn't let the seat jump ahead.
- Playing a card keeps the hold. The seat's own `Pass` releases it, and closing the window clears
  every hold.

A hold only works while the window is open. In real-time play, when nobody else has to decide, the
window may close before you can press Hold: use a stop for that.

## Overrides

The structured flow applies the default rules: a bleed goes to the prey, and only the target (or
prey and predator, for an undirected action) may block. Some card effects lift those rules. The
engine doesn't script card effects, so the player **claims** one with `override: { source? }`,
naming the card that allows it, and the engine records the claim on the action or the block
attempt.

| Rule lifted | Grant | Claimed on | Source may be |
|---|---|---|---|
| Bleed only your prey | `bleed-any` | `DeclareAction` with a target other than the prey | The action card (the default), or one of your face-up cards in play |
| Only eligible seats block | `block-any` | `Block` by a seat that isn't eligible | A card in your hand, played with the attempt, or one of your face-up cards in play |

Sources are always public: in play, the action card (whose identity is public anyway), or played
by the command. The engine never needs to see a hidden card to accept an override.

**Verified or not.** The catalog's `grants` say which cards lift which rule. They come from
`packages/engine/src/grants.ts`, a table of VEKN card IDs with no names or text (LEGAL-08), merged
in by `createCatalog`. A claim whose source carries the grant is **verified**. Any other claim is
accepted but flagged as **unverified**, for untagged cards or effects nobody has tagged yet. An
action card that carries `bleed-any` needs no claim at all.

**Casual and tournament games.**
- Casual: a claim without a source is accepted, as unverified.
- Tournament: the claim must name a source. The action card counts as one.

**What everyone sees.** The log and the status bar show the claim, so the table can respond before
the action goes on:
- "A: Vera Nightfall bleeds C with Long Reach, ignoring the prey restriction (Long Reach)"
- "C tries to block with Ilse Várga, ignoring the blocking restrictions (Quick Feed, unverified)"

A wrong claim is corrected like any other mistake: the acting player cancels the action, or a
judge corrects it. Disputing an unverified claim through a judge call comes with M5b.

**Tagging a card.** Add its VEKN ID and grants to `CARD_GRANTS` in `grants.ts`. Content-pack data
can also carry `grants` on a card; the table only fills in cards that have none.

## Pauses

In a game with a table timer, any player or a judge can **pause** for 1–5 minutes (`Pause`), for
a break away from the table. While paused, the clock stops and every command is refused except
`Resume`, auto-pass and stop settings, and an admin replacing a player. The pause ends by itself
when its time is up, or earlier when whoever paused, or a judge, sends `Resume`. Only one pause at a
time; a player can pause again once it ends, up to **15 minutes in all per game**
(`MAX_PAUSE_TOTAL_MINUTES`, `Seat.pausedMs`; a pause lifted early counts only for as long as it
lasted), so pausing can't hold up a round. Judges have no allowance: a player who needs more can
call one.

## Judge calls

Any seated player can **call a judge** (slow play, a rules question, a dispute, or other), about a
player or not, with a note; one open call per player. The game calls one itself when a deadline
expires or the time limit is reached. While any call is open the table clock stops; play goes on.

A judge **claims** a call so no other judge answers it, then **rules** (claiming it on the way if
nobody had). Rulings, all logged:

| Ruling | Effect |
|---|---|
| Answered at the table | None; for rules questions and disputes settled with the usual tools |
| Pass for the player | A `Pass` for the seat holding the impulse |
| More time to decide | Adds hours to that player's current deadline |
| Add time to the timer | Adds minutes to the time limit (Conduct Guide 1.2.4) |
| Disqualify | Tournament games only. The seat is out like an oust, but nobody gains VP or pool |
| Refer to a server admin | Casual games only; an admin can then replace the player |

A `deadline` call settles itself when that decision stops being overdue: the player came back, or
the game moved on.

## The end of the game

After every command the engine checks whether the game is over (`GameEnded`, GAME-08/09):

| Ending | When | Score |
|---|---|---|
| Last standing | One Methuselah left | They gain 1 VP |
| Nobody left | Everyone left ousted at once (zero-vtes rules-qa 6.9) | Each still scores the VP for an ousted prey |
| Time limit | Time was up, and the action under way then has ended, or (with none) the phase has (Tournament Rules 3.1.1) | ½ VP to everyone still in the game (3.7.2) |
| An admin | `EndGame` (admins only), with an optional note | As at the time limit |
| Agreement | Casual games: `ProposeEnd`, then `AgreeEnd` from everyone still in it; `DeclineEnd` drops the proposal | As at the time limit |

A Methuselah who **withdrew** (below) counts as out, as an ousted one does.

The **winner** has the most VP alone, ousted or not; a tie has no winner. A **game win** also needs
at least 2 VP. A finished game takes no more commands; its timers, deadlines and judge calls stop,
and the lobby lists it as finished.

## Withdrawal

With an **empty library** and **less than a full hand** (for now: fewer than 7 cards; cards that
change the hand size aren't tracked yet), a Methuselah may `Withdraw` in their own **unlock
phase**; the toolbar offers it only then, and asks for confirmation (GAME-09; zero-vtes rules-qa
Batch 95). It is public. They play on as usual, but the withdrawal no longer holds
(`WithdrawalBroken`) if, before their next unlock phase:

- they lose or spend **pool** (a bleed, a pool adjustment down, blood moved from their pool,
  influence transfers included); gaining some back doesn't repair it;
- a **vampire** of theirs in play (ready or torpor) loses or spends **blood**; a minion leaving
  play with its blood doesn't count, nor does an ally's life;
- a **minion** of theirs **enters combat** (blocked, blocking, or in an action that enters combat).

Their own actions count as much as anyone's. Once it no longer holds, they may announce it again
in a later unlock phase, if the conditions hold. If it still holds when their next turn would
start, they leave the game instead (`Withdrew`): ½ VP, the turn goes on to the next Methuselah,
their predator gains nothing, and their cards leave the game as an ousted Methuselah's do.

## Combat

Combat runs like the phases (docs/m6-plan.md M6.4). It starts when a block succeeds, or when an
unblocked action enters combat (`ResolveAction { outcome: 'combat', opponent }`, `resolve combat
<minion>`). The acting minion and its opponent are fixed for the whole combat.

Each round goes through the rulebook's steps, each an impulse window (`kind: 'combat'`):

**Before range → Range → Before strikes → Strikes → Damage → Press → End of round**

- **Who is in it.** Only the two combatants' Methuselahs, the acting minion's first. Other players
  can't play cards in a combat step (they keep the free-form commands). Auto-pass settings and
  stops don't apply.
- **Moving on.** Doing something (`Maneuver`, `PlayCard`, `UseCard`) hands the impulse to the other
  combatant and voids the passes (`ImpulseReset { to }`). Two passes in a row end the step and open
  the next (`CombatStepped`).
- **Card timing isn't checked.** Any card may be played or used in any step. Every log line in a
  step starts with the round and step ("Round 1 · Before strikes: Beast plays Immortal Grapple"),
  so the table sees what was played when.
- **Sources.** `Maneuver` and `Strike` may name the card they come from. A card in the hand is
  played with the move (to the ash heap, and replaced): "Tomas Grey plays Quick Feed to maneuver
  to close". A face-up card in play (a weapon, the minion itself) is only named: "Vera Nightfall
  maneuvers to long using Iron Ward".
- **The end.** For now (M6.4a), after End of round the combat ends, and with it the action:
  blocked, or done for an action that entered combat. Damage, prevention and presses come with
  M6.4b; until then players adjust blood and life by hand. `EndCombat` ends the combat at once,
  in any step.

| Step | What the engine does |
|---|---|
| Range | Keeps the range (close to start) and who maneuvered last. `Maneuver { to, source? }` is refused outside this step or to the current range |
| Strikes | The acting minion's Methuselah chooses first: `Strike { kind, amount?, ranged?, aggravated?, first?, source?, note? }`. Choosing is their pass, so the other chooses next. Nobody can pass before choosing (`kind: 'none'` doesn't strike); one strike per combatant a round. A judge passing for a combatant who hasn't chosen means no strike |
| Every step | `PlayCard`, `UseCard`, `Pass`, `PassUntil`, `EndCombat` |

**Standing passes** (`PassUntil { until: 'strikes' | 'end' }`, "Pass to strikes", "Pass to the end
of the round"): the combatant passes each step automatically, up to the strikes or to the end of
the round, but never past a strike still to choose. It's dropped as soon as anyone does something
in the combat, so the other side can answer.

**Using a card** (`UseCard { card, note? }`): an ability of one of your face-up cards in play,
logged ("Vera Nightfall uses Iron Ward: +1 strength"); nothing else happens. It works outside
combat too; in any window it needs the impulse and hands it on, like playing a card.

Combats from before combat steps (an action at `combat` with no `combat` state) still wait on
both players until one of them ends it with `EndCombat`.

## How windows close

After each command the engine runs the open window forward: it records automatic passes for the
seats that pass automatically, and closes the window once every seat in the order has passed in a
row. It stops as soon as the impulse reaches a seat that has to choose.

A seat **never** passes automatically when it is:
- the acting Methuselah (first in the order);
- in a block window: the acting seat, the seat with the pending block attempt, or an eligible
  blocker that hasn't declined;
- holding the window (`Hold`);
- covered by one of its stops (`SetStops`).

Otherwise it does if the window's phase is in its auto-pass setting.

When a window closes:

| Window | Situation | What happens |
|---|---|---|
| `phase` | – | The phase advances (or the next turn starts) |
| `blocks` | No block attempt pending | The action moves to `resolution` |
| `blocks` | Block attempt pending | The action is blocked and moves to `combat`; the blocking minion is locked, and the first combat step opens |
| `combat` | – | The next combat step, or after End of round, the end of the combat and the action |

### Later: player-defined stops

Stops are a list of rules, so players will be able to define their own, for example "stop when
a Political Action is played" or "stop for any bleed directed at my prey". Each new trigger is a
new `StopRule` variant (`model.ts`), matched in `stopApplies` (`flow.ts`), its only matching
point. Trigger ideas:
- `{ on: 'card-played'; cards?; types?; by? }`: a card play in a window. This needs the window
  to record the last card played, so the impulse can stop for the seats that care.
- `{ on: 'action'; kinds; actors }`: the block window of certain action kinds.
- Priority between stops (which fires first when several seats stop) isn't needed: the impulse
  always follows the window order.

## Action lifecycle

```
DeclareAction ──► blocks window
                   │ every seat passes, no attempt ──► resolution ──► ResolveAction ──► ended (success | failure)
                   │ every seat passes, attempt ─────► combat steps ─► End of round, or EndCombat ─► ended (blocked)
                   resolution ──► ResolveAction combat ──► combat steps ──► … ──────────────────► ended (success)
                   │ Block ──► impulse back to acting player, passes reset
                   │ WithdrawBlock ──► seat declined
CancelAction (any stage) ───────────────────────────────────────────────────────────► ended (cancelled)
```
