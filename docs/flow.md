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
  `blocks` → `combat` or `resolution`, then ends; a successful political action goes on to
  `referendum` first.
- **`window`**: an open impulse window, if any. Its `kind` is `phase` (the end-of-phase round),
  `blocks` (the block window of an action), `combat` (a step of a combat round), `referendum`
  (the cards played before votes) or `polling` (the votes). It holds the seat `order`, the `cursor` (who holds
  the impulse), the number of consecutive `passes`, and the seats that asked it to wait
  (`holds`).

## Who the game waits on

`waitingOn(state)` in `flow.ts` derives it from the state above; prompts, and later deadlines and
notifications, read only this.

| Situation | Waits on | Kind |
|---|---|---|
| A window is open, the impulse holder is an eligible blocker who hasn't declined, no block attempt pending | The impulse holder | `block` |
| The would-be-successful window, the acting Methuselah holding the impulse | The acting Methuselah | `resolve` |
| Any other open window | The impulse holder | `impulse` |
| An action at `resolution` | The acting Methuselah | `resolve` |
| A combat step is open | The impulse holder | `combat` |
| A referendum's polling is open | The impulse holder | `vote` |
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
- No action is in progress ("Finish the current action first"). In the last action's
  after-resolution window, the acting player holding the impulse may still end the phase: see
  [the acting Methuselah moving on](#the-acting-methuselah-moving-on).
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

### 0b. A referendum's polling is open

The seat holding the impulse gets these ([Referendums](#referendums)); every other seat gets
**Abstain**.

| Offer | Shown when | Command |
|---|---|---|
| **Vote with *vampire* (*n*)…** | For each of the seat's ready titled vampires (a priscus: 1 ballot) not yet cast and not abstaining. Step: for or against | `CastVotes { source: 'minion', minion, side }` |
| **Votes from a minion (card effect)…** | The seat has a ready minion. Steps: the minion, the votes, the side | `CastVotes { source: 'minion', minion, votes, side }` |
| **Burn the Edge for a vote…** | The seat has the Edge | `CastVotes { source: 'edge', side }` |
| **The calling card's vote…** | The caller, with a calling card not yet cast | `CastVotes { source: 'card', side }` |
| **Burn a political action card for a vote…** | Not the caller with a calling card, a political action card in hand, none burned yet | `CastVotes { source: 'burned', card, side }` |
| **Other votes…** | Always. Steps: the votes, the side, the card they come from (optional), a note | `CastVotes { source: 'other', votes, side, card?, note? }` |
| **Make a vampire abstain…** | Any vampire in play not already abstaining. Steps: the vampire, the card it comes from (optional) | `CancelVotes { minion, source? }` |
| **End the referendum…** | The caller. Steps: it passes or fails, why (optional) | `EndReferendum { passed, note? }` |
| **Play a card**, **Use a card…**, **Pass**, **Abstain** | As in a combat step; Pass is highlighted unless a titled vampire is | `PlayCard`, `UseCard`, `Pass`, `Abstain` |

In the `referendum` window before it, the usual window offers apply (case 1), with **Abstain**
added for every seat in it.

### 1. A window is open

The seat holding the impulse gets the offers below. Every other seat in the window except the
acting Methuselah gets **Hold** (`Hold`), unless it is already holding.

| Offer | Shown when | Command |
|---|---|---|
| **Block** (highlighted) | Block window, no block attempt pending, the seat is eligible and hasn't declined, and it has an unlocked ready minion | `Block { minion }` |
| **Block (card effect)…** | Block window, no block attempt pending, the seat isn't eligible, hasn't declined and isn't acting, and it has an unlocked ready minion. Steps: the card that allows it (a Reaction from the hand or a face-up card in play; optional in casual games), then the blocking minion | `Block { minion, override }` ([Overrides](#overrides)) |
| **Withdraw block** | The seat made the pending block attempt | `WithdrawBlock` |
| **Successful**, **Unsuccessful**, **Enter combat…**, **Cancel action** | The would-be-successful window, to the acting Methuselah: the resolution offers of [2](#2-an-action-is-in-progress-no-window-open), which pass the window first | `ResolveAction`, `CancelAction` |
| **Play a card** | The hand isn't empty | `PlayCard { card }` |
| **Pass**, or **Don't block** when Block is offered | Always | `Pass` |
| The next action's offers, and **End minion phase** | The after-resolution window, to the acting Methuselah: as in [3](#3-no-action-no-window), passing the window first | `DeclareAction`, `AdvancePhase` |

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
- Political action: the terms of the referendum (optional text); the offer reads **Successful:
  call the referendum**.

A rescue's success asks for the blood paid in all (2 by default), a diablerie's for nothing. An
`other` action at `resolution` (a diablerie by a card) also offers **Call a blood hunt…**: the
diablerist, the acting vampire unless another is chosen (`CallBloodHunt`).

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
- The minion is the sender's, in their ready region, and unlocked. For `leave-torpor` it is one of
  their vampires in torpor, face up and unlocked instead: a vampire in torpor can take no other
  action (rulebook, "Torpor"). Leaving torpor is undirected; a target is ignored.
- `rescue` and `diablerie` (rulebook, "Rescue a Vampire from Torpor", "Diablerize a Vampire in
  Torpor"): the minion is a vampire, and `vampire` a face-up vampire in torpor, anyone's. The
  action is directed at that vampire's controller when it's another Methuselah's, undirected when
  it's the sender's own (zero-vtes rules-qa 16.4); a target is ignored. A rescue's
  `rescuedPays` (0 to 2) is the blood the rescued vampire pays, chosen now (48.8).
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

In the after-resolution window of the last action, the acting Methuselah holding the impulse may
declare the next one: see [the acting Methuselah moving on](#the-acting-methuselah-moving-on).

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
- No other seat's block attempt is pending. The seat whose attempt is under way may start another
  with a different minion: the attempt under way fails, and only one runs at a time (zero-vtes
  rules-qa 48.3, 114.1). Passing on it declines to block (82.1).
- The minion is the sender's, in their ready region, and unlocked (rulebook: only ready unlocked
  minions block; a card that lets a locked minion block means unlocking it first).
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

### `ResolveAction { outcome, amount?, edge?, terms? }`

Checks: the sender owns the action (or is a judge), the action is at `resolution` with no window
open, and the amount is a whole number of 0 or more (default 1). In the would-be-successful window,
the acting Methuselah holding the impulse may resolve: see
[the acting Methuselah moving on](#the-acting-methuselah-moving-on).

Effect:
- Successful political action: calls the referendum on `terms` ([Referendums](#referendums));
  the action ends when it's over. If the acting vampire is no longer ready, no referendum is held
  and the action ends successful (zero-vtes rules-qa 5.9).
- Successful bleed: the target loses that much pool (no more than they have). With `edge`, the
  acting seat takes the Edge if it doesn't already have it, unless the amount is 0: only a bleed
  of 1 or more is successful (zero-vtes rules-qa 24.4).
- Successful hunt: the minion gains that much blood, capped at its capacity when the catalog
  knows it.
- Successful leave-torpor action: the vampire moves to its ready region and pays `amount` blood (2
  by default, the rulebook's cost; less for a card that reduces it). If it can't pay, or is out of
  torpor already, the action fizzles: successful, nothing happens, nothing is paid (zero-vtes
  rules-qa 3.6, 28.7). `combat` is refused: a vampire in torpor can't enter combat.
- Successful rescue: `amount` blood in all (2 by default); the rescued vampire pays its share as
  announced, the rescuer the rest, and the rescued vampire moves to its controller's ready region.
  A share its payer can't meet, or the vampire out of torpor, fizzles it (rules-qa 3.6, 28.7,
  48.8).
- Successful diablerie: the diablerie (its blood to the diablerist, up to capacity; the victim
  burned with its cards), then the blood hunt at once, polled from the acting Methuselah; the
  action concludes successful when it's over (rules-qa 5.8). The victim out of torpor, or either
  vampire face down or out of play, it fizzles with no blood hunt (28.7).
- The action card is finished and the action concludes: its after-resolution window opens
  ([Action windows](#action-windows)).

### `EndCombat`

Checks: the action is at `combat`, and the sender is the acting player, controls the blocker, or
is a judge.

Effect: in a combat with steps, it goes straight to End of round, marked as ending: no strike
resolves, damage pending is dropped, and the end-of-round window still opens (zero-vtes rules-qa
19.5); when it closes the combat is over. Refused once it's ending there. In a combat from before
combat steps, it ends at once. Either way, the action card is then finished and the action
concludes, as blocked or (an action that entered combat) successful.

### The acting minion leaving

If the acting minion leaves its ready region while the action is still at `blocks` (burned, sent
to torpor by a card effect, or moved there by the players), the action ends at once with outcome
`minion-gone` (rulebook, "Resolve the Action"; zero-vtes digest §24.3). A block attempt under way
is dropped, so the blocker isn't locked; the action card, played, goes to the ash heap and is
replaced. Ended before resolution, it has no after-resolution window (§3.2). A vampire leaving
torpor ends its action this way only by leaving play. After blocks, a minion gone by resolution
is the resolution's business (a political action calls no referendum, rules-qa 5.9).

### `Diablerize { decline? }`

A blocked leave-torpor action has no combat (rulebook, "Leave Torpor"). When every seat has passed
on a block attempt by a **vampire**, the action waits at stage `diablerie` on that vampire's
Methuselah (wait kind `diablerie`); blocked by an **ally**, it simply ends as blocked.

Checks: the action is at `diablerie`, and the sender controls the blocking vampire (or is a judge).
To diablerize, the vampire must still be in torpor, and both vampires face up and in play.

Effect:
- `decline`: the action concludes as blocked; the vampire stays in torpor and pays nothing.
- Otherwise a diablerie (rulebook, "Diablerie"): the victim's blood moves to the diablerist, up to
  its capacity, the rest draining off; the victim is burned with every card on it. Taking its
  equipment, and a Discipline from an older victim, are left to the players' moves. The blood
  hunt follows at once, as with `CallBloodHunt` (no cards played before votes, polling from the
  acting Methuselah); when it's over the action concludes as blocked.

### `CancelAction`

Check: the sender owns the action (or is a judge), and it hasn't concluded.

Effect: closes any open window and ends the action as cancelled. A cancelled action has no
after-resolution window.

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
change the hand size aren't tracked yet), both read **as their turn begins** (zero-vtes rules-qa
95.3; `Turn.shortHand`), a Methuselah may `Withdraw` in their own **unlock phase**; the toolbar offers it only then, and asks for confirmation (GAME-09; zero-vtes rules-qa
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

- **Who is in it.** Every Methuselah: the acting minion's first, then the opposing one's, then the
  others clockwise from the acting one, for cards that reach a combat they're not in (Rötschreck,
  Abjure; zero-vtes rules-qa 98.1, 98.2). Only the combatants maneuver, strike, prevent and
  press; the others play a card or pass, and pass automatically as in any window unless they
  hold the step or their auto-pass is off. The combatants never pass automatically except by
  their standing passes. A hold lasts one step.
- **Moving on.** Doing something (`Maneuver`, `PlayCard`, `UseCard`, `Prevent`,
  `AdditionalStrike`, `Press`) returns the impulse to the acting minion's Methuselah, who may play
  again, and voids the passes (`ImpulseReset`; rulebook, "Impulse"). The other side answers once
  the acting side passes. Two passes in a row end the step and open the next (`CombatStepped`). A
  minion can't maneuver, or press, twice in a row.
- **Card timing isn't checked.** Any card may be played or used in any step. Every log line in a
  step starts with the round and step ("Round 1 · Before strikes: Beast plays Immortal Grapple"),
  so the table sees what was played when.
- **Sources.** `Maneuver`, `Strike`, `Prevent`, `AdditionalStrike` and `Press` may name the card
  they come from. A card in the hand is
  played with the move (to the ash heap, and replaced): "Tomas Grey plays Quick Feed to maneuver
  to close". A face-up card in play (a weapon, the minion itself) is only named: "Vera Nightfall
  maneuvers to long using Iron Ward".
- **The end.** After End of round, another round follows if a press to continue stood;
  otherwise the combat ends, and with it the action: blocked, or done for an action that entered
  combat. `EndCombat` ends the combat at once, in any step.

| Step | What the engine does |
|---|---|
| Range | Keeps the range (close to start) and who maneuvered last. `Maneuver { to, source? }` is refused outside this step or to the current range |
| Strikes | The acting minion's Methuselah chooses first: `Strike { kind, amount?, ranged?, aggravated?, first?, source?, note? }`. Choosing is their pass, so the other chooses next. Nobody can pass before choosing (`kind: 'none'` doesn't strike); one strike per combatant an exchange. A judge passing for a combatant who hasn't chosen means no strike. When both are in, the engine works out the damage (below); a combat-ends strike skips to End of round, and the combat ends then |
| Damage | Shows the damage each minion is about to take (`DamagePending`). `Prevent { points, source? }` takes points off the damage your combatant is about to take, aggravated first. `AdditionalStrike { source? }` claims another strike. When the step closes, the damage is applied (below); then any strikes still to resolve after first strikes, then an exchange of additional strikes (Strikes and Damage again, at the same range, by those who claimed one), then Press. A combatant no longer ready (torpor, burned) skips the presses: the combat ends after End of round |
| Press | `Press { mode: 'continue' \| 'end', source? }`; a minion can't press twice in a row. If more presses to continue than to end stand when the step closes, another round follows the end of this one, from Before range |
| Every step | `PlayCard`, `UseCard`, `Pass`, `PassUntil`, `EndCombat` |

**Which strikes land** (`combat.ts`): a hand strike, a damage strike and steal blood do their
amount; dodge, combat ends and `other` strikes do no damage. A dodge cancels the other strike
against the dodger. At long range, only ranged strikes (R) land. First strikes resolve on their
own first, when other strikes follow; those then resolve only if their striker is still ready.

**Taking damage** (C5). Prevention comes off aggravated damage first.
- A **vampire** (a crypt card) mends normal damage with blood, one for one; damage it can't mend
  leaves it wounded. Aggravated damage can't be mended: the first point wounds an unwounded
  vampire, and each point on a wounded vampire costs a blood, or the vampire is burned. A
  wounded vampire goes to torpor, keeping its cards.
- An **ally** (a library card) loses a life per point, aggravated or not, and is burned at 0.
- **Steal blood** moves blood, or an ally's life, to the thief (an ally thief gains life), before
  anyone mends: the thief can mend damage taken in the same exchange with it. What's over a
  vampire thief's capacity drains off at once. An ally with no life left is burned. It isn't
  damage, so it can't be prevented ("Vera Nightfall steals 2 life from Gate Hound; 1 drains off,
  over capacity").
- A burned minion goes to its owner's ash heap with the cards on it. The log tells each outcome
  ("Tomas Grey takes 2 damage (1 blood) and goes to torpor").

**Standing passes** (`PassUntil { until: 'strikes' | 'end' }`, "Pass to strikes", "Pass to the end
of the round"): the combatant passes each step automatically, up to the strikes or to the end of
the round, but never past a strike still to choose. It's dropped as soon as anyone does something
in the combat, so the other side can answer.

**Using a card** (`UseCard { card, note? }`): an ability of one of your face-up cards in play,
logged ("Vera Nightfall uses Iron Ward: +1 strength"); nothing else happens. It works outside
combat too; in any window it needs the impulse and returns it to the acting side, like playing a
card.

Combats from before combat steps (an action at `combat` with no `combat` state) still wait on
both players until one of them ends it with `EndCombat`.

## Referendums

A successful political action calls a referendum (docs/m6-plan.md M6.5): the terms, the polling
step, the tally. The engine keeps the steps and the count; what a passed referendum does is
applied by the players with the usual commands.

1. **Terms.** Chosen as the action succeeds: `ResolveAction { outcome: 'success', terms }`. The
   engine doesn't read them; they're in the log and on the referendum panel.
2. **Before votes** (`referendum` window): for the cards played "before votes and ballots are
   cast". The impulse starts with the caller's prey and goes round the table, the caller last
   (zero-vtes rules-qa 64.12). It's an ordinary window: auto-pass (the minion phase's setting),
   holds and stops apply, and a play returns the impulse to the caller. Votes can't be cast yet.
3. **Polling** (`polling` window): from the caller round the table. Everyone passes by hand,
   whatever their auto-pass setting; `Hold` isn't needed and is refused. Whatever the seat
   holding the impulse does (casting votes, playing or using a card) keeps the impulse with it
   and sets the passes back to zero (`ImpulseReset { to }`), so everyone gets another chance to
   answer before the tally (rules-qa 5.3). The window closes after a full round of passes.
   `Abstain` passes every turn of this polling for the seat, from then on.
4. **The tally.** More votes for than against passes it; a tie fails (`ReferendumResolved`).
   Passed or not, the action ends successful and the political action card goes to the ash heap
   (rules-qa 5.8).

**`CastVotes { source, side, minion?, card?, votes?, note? }`**, on your impulse in polling:

| Source | Checks and effect |
|---|---|
| `minion` | One of your ready minions, locked or not. Votes default to its title's (`titleVotes`: primogen and bishop 1; prince, baron, archbishop, magaji and kholo 2; justicar and cardinal 3; Inner Circle and regent 4; "*n* votes" *n*; a priscus none, its ballots go to the prisci block). Another number is accepted and logged as claimed. A minion is cast once, all one way (rules-qa 1.1); casting it again only adds votes on the same side (5.1) |
| `edge` | You have the Edge; it's burned for 1 vote |
| `card` | The caller's 1 vote from the calling political action card (5.4) |
| `burned` | A political action card from your hand, burned (and replaced) for 1 vote. One each per referendum; never the caller when a card called it (46.2) |
| `other` | `votes` from any other source; `card` names where they come from: a card in your hand is played, one of your face-up cards in play is only named |

Casts are public and never change. `ReferendumState` keeps them in order, with the seats
abstaining and the minions made to abstain.

**The prisci block** (rulebook, "The Prisci Block"; rules-qa 52.9): a priscus casts 1 ballot by
default (`titleBallots`), in a sub-referendum: whichever side has more ballots gets the block's 3
votes; a tie gives them to neither (`tally` in `referendum.ts`).

**Making a vampire abstain** (`CancelVotes { minion, source? }`, rules-qa 76.6, 77.14): on your
impulse in polling, any vampire in play; its votes and ballots, cast or to come, are cancelled. A
card from your hand is played for it; one in play is named.

**Ending it at once** (`EndReferendum { passed, note? }`): the caller or a judge settles the
referendum, passed or failed, for cards that do (Yoruba Shrine 35.4, Fakir al Sidi 59.18, Día de
los Muertos 52.3). What follows is as for a tally.

**Blood hunts** (`CallBloodHunt { minion? }`; rulebook, "The Blood Hunt"): the acting Methuselah,
or a judge, calls one while an `other` action resolves, after a diablerie a card made and the
players played out by hand. A `diablerie` action, and a blocked leave-torpor action's
`Diablerize`, call theirs themselves. It's not an action: polling opens at once, from the acting
Methuselah, with no cards played before votes and no calling card; anyone may burn a political
action card for a vote (rules-qa 5.2). Nor are cards played in its polling (PIB 20150105; digest
§24.3): `PlayCard`, and votes from a card played from the hand, are refused; votes named from a
card in play still count. If it passes, the diablerist is burned with the cards on it; then a
`diablerie` action concludes successful, a blocked leave-torpor action blocked, and an `other`
action goes back to resolving.

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

In polling, a seat passes automatically only if it abstains. Otherwise it does if the window's
phase is in its auto-pass setting.

When a window closes:

| Window | Situation | What happens |
|---|---|---|
| `phase` | – | The phase advances (or the next turn starts) |
| `blocks` | No block attempt pending | The action moves to `resolution`; for a bleed or a political action, the would-be-successful window opens |
| `would-succeed` | – | Back to the acting Methuselah, to resolve the action |
| `after-resolution` | – | The action ends |
| `blocks` | Block attempt pending | The action is blocked and moves to `combat`; the blocking minion is locked, and the first combat step opens |
| `combat` | – | The next combat step, or after End of round, the end of the combat and the action |
| `referendum` | – | The polling opens, from the caller |
| `polling` | – | The tally; the action concludes successful, or after a blood hunt goes back to resolving |

## Action windows

Two windows around an action's resolution come from zero-vtes (`docs/rules-digest.md` §5.2,
§10.1, §10.4, checked at `1f33be5`). Both take the action's order: the acting Methuselah first,
then the target (directed) or prey and predator (undirected), then the rest clockwise.

- **Would be successful** (`would-succeed`): when every seat passes on a bleed or a political
  action with no block attempt, before it resolves. It's for cards played "if a bleed would be
  successful" (Spying Mission), Major Boon, and Yawp Court on a political action (rules-qa 24.2,
  54.1, 68.13). None once the action has failed: resolving it `failure`, or a bleed for 0, closes
  the window at once, whoever is holding it.
- **After resolution** (`after-resolution`): after every action that succeeds, fails or is blocked
  (rules-qa 5.8, 23.3); for a political action after its referendum, after a diablerie after its
  blood hunt. `ActionConcluded { outcome }` puts the action at stage `after` and opens it;
  `ActionEnded` follows when it closes. A cancelled action, or one ended by an oust of its acting
  Methuselah, has none. A target ousted by the action leaves the window, which stays open
  (rules-qa 24.1).

### The acting Methuselah moving on

Both windows open on the acting Methuselah, who never passes automatically, so each would cost
them a pass on every action. Instead, holding the impulse there, their next move passes the window
for them: `ResolveAction` in the would-be-successful window, `DeclareAction` or `AdvancePhase` in
the after-resolution window. It's a pass, then the command, when every other seat in the window
would pass automatically (no hold, no stop, auto-pass on for the phase); otherwise the command is
refused, and they pass by hand and wait for the others, as before. Once time is up and the game ends
with this action, the after-resolution window is passed by hand, so the game ends with it.

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
                   │ every seat passes, no attempt ──► resolution ──► ResolveAction ──► concluded (success | failure)
                   │   (bleed, political: would-succeed window first)
                   │ every seat passes, attempt ─────► combat steps ─► End of round, or EndCombat ─► concluded (blocked)
                   │ (leave-torpor) attempt by a vampire ──► diablerie ──► Diablerize ──► blood hunt ──► concluded (blocked)
                   │                                                    └─ Diablerize decline, or an ally's block ──► concluded (blocked)
                   resolution ──► ResolveAction combat ──► combat steps ──► … ──────────────────► concluded (success)
                   resolution ──► ResolveAction success (political) ──► before votes ──► polling ──► concluded (success)
                   │ Block ──► impulse back to acting player, passes reset
                   │ WithdrawBlock ──► seat declined
concluded ──► after-resolution window ──► every seat passes ──► ended
acting minion leaves the ready region (at blocks) ──────────────────────────────────► ended (minion-gone)
CancelAction (before it concludes) ─────────────────────────────────────────────────► ended (cancelled)
```
