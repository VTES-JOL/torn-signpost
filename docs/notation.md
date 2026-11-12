# VTES Script Notation (GAME-22): draft

**Status: draft for review.** Nothing here is built yet beyond what the scenario language already
does. The decisions made so far are listed at the end.

VTES Script Notation (`.vsn` files) is a text notation for recording a VTES game, played here or anywhere else: like chess notation, but
including the conversation at the table. Anyone can transcribe a game into it, from a video, a
tournament report or their own notes, and the Replay page plays it on the real table. Every game
played on Torn Signpost can be exported in it, too.

## Goals

- **Any game.** A game played on paper, on another platform or here can be written down. Card
  effects are recorded by what they did (`move`, `blood`, `pool`, `use`), so a record never depends
  on the engine knowing a card. That covers cards printed after the engine was written.
- **As much detail as is known.** A full record has every pass and every impulse; a quick
  transcription has the actions, the plays and the outcomes. Both are valid. The replayer fills in
  what can be inferred and says where it had to guess.
- **The table talk.** Deals, threats, questions to the judge and jokes are part of the game.
- **Readable and writable by hand.** It's plain text that a player can follow without the app, and
  that a transcriber can type as a game unfolds.
- **One grammar.** Moves use the command console's syntax (`docs/console.md`). A game record is the
  scenario language without its test assertions, plus a few additions. Scenarios stay as they are,
  and a scenario is a valid record.
- **Stable.** Records name a notation version, and later versions still read earlier records.

Not goals: automating card text, checking that hidden information in a transcript is true,
replacing the tournament archon (results go there too), and being the definitive account of a
game. A record is one transcription, made to be replayed; two people may write the same game down
differently, and the notation doesn't try to reconcile them.

## A record at a glance

```text
[Notation "1"]
[Event "Winter Open 2026"]
[Site "Lisbon"]
[Date "2026-11-14"]
[Round "Final"]
[Format "standard"]
[TimeLimit "2h"]
[Source "Transcribed by Sam from the stream VOD"]
[Detail "actions"]
[Result "C 3, A 1, B 1, D 0, E 0"]

seat A "Ana Reis"
seat B "Bo Lindqvist"
seat C "Cai Wen"
seat D "Dee Okafor"
seat E "Eli Moreau"
crypt A "Vera Nightfall" *6 "Ilse Várga" *6
library A "Iron Ward" *30 "Quick Feed" *30
crypt B ?                         # deck not published: cards are named as they're seen
library B ?
start

== Turn 1: A ==
A> transfer +1 "Vera Nightfall"
A> next
== Turn 2: B ==
B: "Nobody bleeds me early and I'll vote with you all game."
C: "Deal."
...
== Turn 9: A ==
A> bleed "Vera Nightfall" B       # the passes before it are implied
B> block "Tomas Grey"
A> strike 2
B> strike hand
# Vera takes 1, Tomas 2: he goes to torpor.
A> move B:ready:"Tomas Grey" torpor
...
```

## Structure

A record is a **header**, the **seating and decks**, `start`, and then the **game**: moves,
conversation, time marks and comments, in the order they happened.

### Header

Tag pairs, one per line, as in chess's PGN. Unknown tags are kept and shown, never an error.

| Tag | Required | Meaning |
|---|---|---|
| `Notation` | yes | The notation version this record is written in (`"1"`) |
| `Format` | yes | `standard`, `v5` or `duel` |
| `Event`, `Site`, `Date`, `Round`, `Table` | no | Where and when (`Date` is ISO, `YYYY-MM-DD`, with `??` for unknown parts) |
| `Tournament` | no | `"yes"` for a tournament game: tournament rules apply (no overrides without a source) |
| `TimeLimit` | no | The round's time limit, e.g. `"2h"` |
| `Source` | no | Where the record comes from: a VOD, report or the transcriber's notes |
| `Transcriber` | no | Who wrote it down |
| `Detail` | no | `full` (every pass and impulse), `actions` (the default: actions, plays, outcomes) or `summary` (turn by turn, outcomes only) |
| `Result` | no | Final VP per seat. The replay compares it with the result it reaches |
| `Platform` | no | `"Torn Signpost"` and the game's ID for exported games; otherwise where it was played |

### Seats and decks

`seat <id> "<name>"`, in clockwise order from the first player. Names are the players' names as
the source gives them; they aren't accounts here.

Decklists use the scenario syntax (`crypt A "Name" *n …`, by name or VEKN ID), with two
additions:

- `?` for a deck that isn't known. Its cards are named as they're seen; the replay shows the rest
  as unknown.
- `deck A "<url>"` for a published decklist (VDB, Amaranth, the archon) that the replayer may fetch.
  It is checked against the cards seen, and a mismatch is reported, not fatal.

### The game

| Line | Meaning |
|---|---|
| `A> <command>` | A move by seat A's player, in console syntax |
| `judge> <command>` | A judge's correction or ruling (the console's judge commands) |
| `A: "<text>"` | Seat A's player says something to the table. Everything said is said to the whole table: VTES has no private table talk |
| `judge: "<text>"`, `crowd: "<text>"` | A judge or someone not at the table speaks |
| `== Turn 9: A ==` | A turn marker. Optional; when present, the replay checks that it's right |
| `@ 1:12:30` | Time mark: the round's clock (or the video's time) at this point. Optional |
| `# comment` | Commentary, as in scenarios. Shown beside the replay |

Speech is free text in double quotes, with `\"` for a quote inside. Speech has no effect on the
game: a deal is recorded as said, and what's done about it is recorded as moves.

## What's new compared with scenarios

### No seed: cards are named when they appear

Scenarios fix shuffles with `seed`, so `A:hand:4` is known in advance. A real game's shuffles
aren't, so in a record:

- **Libraries and crypts are unordered** until something is drawn. `draw` and `draw crypt` take the
  names of what was drawn when the source shows it: `A> draw "Iron Ward"`,
  `A> draw crypt "Vera Nightfall" "Ilse Várga"`.
- **Unknown cards.** `A> draw 2` with no names draws two cards the record doesn't know (`?`). When
  one is played, discarded or revealed by name, the replay fills it in from then on and back to
  when it was drawn: `A> play "Quick Feed"` takes an unknown card from A's hand and names it.
- **Uncontrolled vampires** work the same way, named as they're influenced out or revealed.
- **Consistency.** With a known decklist, the replay checks that no card is drawn more often than
  the deck holds. Without one, anything goes.

`seed` stays for scenarios, and for exports from Torn Signpost, which know every card.

### Cards by name

Records name cards as people do: `"Vera Nightfall"`, or with a zone when it matters,
`A:ready:"Vera Nightfall"`. With two copies in play, `"Iron Ward"#2` is the second in zone order.
Positions (`A:hand:3`) still work, and VEKN IDs work wherever a name does.

A name resolves to the **current** card: an older printed name, or a name the card has since been
errata'd away from, resolves through the content pack's aliases (`CardRecord.aliases`) to the card
as it is now, and the replay shows the current card. A name that resolves to nothing, or to more
than one card, stops the replay with the candidates listed.

A record names a card; the card's text and image come from the content pack when the record is
replayed, as everywhere else (LEGAL-08).

### Implied passes

At `actions` and `summary` detail, records leave out most passes. Before applying a line, the
replay works out the passes that must have happened for the line to be possible: the end-of-phase
rounds, a prey that didn't block, combatants passing through steps nobody used. It marks those
steps as implied in the replay. When more than one sequence is possible, it says so and takes the
simplest (everyone passes). A `full` record has no implied steps, and the replay reports any it
would have needed.

### Mistakes and rulings

Real games contain plays the rules don't allow, and rulings that let them stand. The engine
rejects such a line in a scenario. In a record, a line prefixed `!` is applied as written, using
the free-form moves where the structured command is refused, and flagged in the replay as played
against the rules:

```text
! B> block "Tomas Grey"          # B wasn't eligible to block; the table missed it
judge: "The block stands, it's past the point of correction."
```

Without the `!`, a refused line stops the replay there with the engine's reason, so a
transcription error is found rather than hidden.

### Detail levels: no minimum

There is no minimum detail. Every command is valid in any record, and the `Detail` tag only tells
the reader (and the review editor) how much the transcriber meant to include:

- `full`: every pass and impulse, as a Torn Signpost export has it.
- `actions`: every action, block, card played and outcome; passes are implied.
- `summary`: outcomes only. A turn can be a few lines (`B> pool -3`, `A> vp +1`, a card moved to
  the ash heap).

The same bleed, at each level:

```text
A> bleed "Vera Nightfall" B      # full: every impulse
C> pass
D> pass
B> pass
A> resolve success 3

A> bleed "Vera Nightfall" B      # actions: the passes are implied
A> resolve success 3

B> pool -3                       # summary: what changed, not what happened
```

The less detail, the less the replay can show and check: a `summary` line logs "B's pool −3"
rather than "Vera Nightfall bleeds B for 3", and the engine can't tell a mistaken one from a right
one. Records are expected to mix levels, precise where the source is precise.

### Checkpoints: stretches the source doesn't cover

When a source skips part of a game ("turns 5–8: nothing much happens"), a **checkpoint** sets the
table to a known state instead of deriving it from moves:

```text
== Turns 5–8 not recorded ==
checkpoint pool A 14, B 9, C 22 · vp C 1 · edge C · turn 9 A unlock
```

It sets what it names (pool, VP, the Edge, ousted seats, the turn and phase) and nothing else. The
replay jumps across it and marks it as a gap. The board after a gap is uncertain: cards in play stay
as they were unless moves after the checkpoint change them, and the replay shows that the board
hasn't been confirmed since the gap. A checkpoint is the one kind of line that isn't a move; it's
for honesty about what the source doesn't say, never a shortcut through what it does.

## Reviewing a record

A record is run through the engine before it's replayed or shared. The **review editor** shows the
record beside the table at each step, and lists what the run found, so whoever is transcribing can
fill in detail where it's needed:

- **Refused lines**: a line the engine won't apply, with its reason. Fix the transcription, or mark
  the line `!` if the table really did play it that way.
- **Implied steps**: passes the replay had to infer, and the places where more than one sequence was
  possible. Accept them, or write in what happened.
- **Unknown cards** still unnamed at the end, and draws that exceed a known decklist.
- **Gaps**: checkpoints, and anything they changed that later moves contradict.
- **The result**: whether the replay's final VP match the `Result` tag.

Edits in the editor change the record's text, so what's saved is still a plain `.vsn` file. A
record with nothing flagged replays cleanly; one with flags still replays, with the flags shown.

## Torn Signpost exports

A finished Torn Signpost game exports at `full` detail, with a `seed` line, its chat as
conversation, and every judge ruling and automatic step as it happened. Replaying an export must
reproduce the game's log exactly. Running that on every finished game is the test that the
notation captures everything.

## Worked example

To come, before the spec is final: a complete real game (one of the rulebook's examples played
out, or a published tournament final) written at `actions` detail, with its replay checked. It
will be written with VEKN IDs in the repository, so it carries no card data (LEGAL-08); the same
record with names is what a transcriber would write.

## Building it

Roughly in this order, each one usable on its own:

1. **Header, conversation, turn markers and time marks**: parse them, and show conversation in the
   replay's log. Torn Signpost exports (with GAME-17, replays of finished games).
2. **Cards by name**, and `"Name"#n`.
3. **Unknown cards** that are filled in when named. This is the largest engine change: a zone
   holding cards whose identity the record doesn't know yet, alongside the hidden cards the
   projection already models.
4. **Implied passes**, the `Detail` levels and **checkpoints**.
5. **`!` lines** and the deviation report.
6. **Import** on the Replay page: paste or upload a record; it's replayed in the browser and kept
   only if the user saves it.
7. **The review editor**: the record beside the table, the run's findings listed, and edits that
   write back to the record's text.

## Decided

- **Name**: VTES Script Notation, `.vsn` files.
- **No private remarks**: VTES has no private table talk; everything said is to the whole table.
- **Disputes are out of scope**: a record exists to be replayed, not to be the definitive account;
  different transcriptions of the same game are simply different records.
- **Card names resolve to current cards**, through the content pack's aliases.
- **No minimum detail**: `Detail` is information, not a requirement. Checkpoints cover stretches a
  source skips, and the review editor shows what a record leaves out so it can be filled in.
