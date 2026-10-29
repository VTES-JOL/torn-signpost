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
| `next` | Advance to the next phase, or end the turn after discard |
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

```text
# comment
seed 7                         # deterministic shuffles
format standard|v5|duel
tournament                     # mark the game as a tournament game
seat A alice                   # seats in clockwise order
crypt A "Vera Nightfall" *12   # deck lists; *n repeats the previous card
library A "Iron Ward" *40
start

A> draw crypt 4                # a command by seat A's player; also judge> and admin>
reject A> look A:library:1     # the command must fail; reject:<code> pins the rejection code

expect pool A 30
expect vp A 1.5
expect edge A|none
expect direction prey|predator
expect turn 2 B unlock
expect occupant B erin
expect count A:hand 7          # cards in a zone
expect sees B A:hand 0         # how many cards in a zone the viewer can identify (seat, judge, public)
expect card A:ready:1 blood 7  # zone, controller, owner, locked, faceDown, contested,
                               # blood, life, generic, attached
log B A drew 7 cards from their library   # a log line, as the given viewer reads it
```
