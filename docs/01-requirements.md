# Torn Signpost — Requirements

Status: **APPROVED** (Phase 1 signed off 2026-10-29)
Last updated: 2026-10-29 (amended during Phase 2: timers, judge calls, player replacement, seating)

## 1. Vision

**Torn Signpost** (https://tornsignpost.org) is an independent, open-source online platform for playing *Vampire: The Eternal Struggle* that works equally well
as a play-by-post game spread over days and as a live session at a shared virtual table, on any
device from a phone to a desktop Mac. The engine models the game's structure (zones, phases,
pool, blood, turn order) and guides players through it, while still allowing the overrides
a physical table allows.

Prior art used for inspiration only (this is a from-scratch design):

| Project                                              | Takeaway                                                                                                        |
|------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------|
| JOL / deckserver.net (`VTES-JOL/JOL`, `jol-rebuild`) | Proven async play-by-post model, command language, structured-tabletop approach, deck formats, tournament admin |
| succubus-club                                        | Real-time, visual table play in the browser                                                                     |
| zero-vtes                                            | Minimal, lightweight tabletop approach                                                                          |
| local `tournament-seating`                           | Seating solver to reuse/port for tournaments                                                                    |

## 2. Key decisions (made during requirements gathering)

| #   | Decision            | Choice                                                                                                                                                                                                                                                                                                                           |
|-----|---------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| D1  | Game tempo          | **One continuous model**: games run in real time by default and pause whenever input is needed from an offline player, resuming when that player responds. Play-by-post emerges naturally; there is no mode switch                                                                                                               |
| D2  | Rules enforcement   | **Structured tabletop** — engine tracks state & phases, guides actions, players can override; card-level automation added incrementally                                                                                                                                                                                          |
| D3  | Language / stack    | **TypeScript everywhere**: Node Lambdas, React web, one rules-engine package shared by server and clients                                                                                                                                                                                                                        |
| D4  | Mac app             | **True native SwiftUI**, running the shared TS engine via JavaScriptCore for validation/previews                                                                                                                                                                                                                                 |
| D5  | Relationship to JOL | **Independent project** — no data migration; deck import from common formats only                                                                                                                                                                                                                                                |
| D6  | MVP scope           | Gameplay **+ deck builder, lobby & chat, tournaments, stats**                                                                                                                                                                                                                                                                    |
| D7  | Sign-in             | **Email + password, Google, Apple**. Linking a VEKN ID is optional/post-MVP (AUTH-03)                                                                                                                                                                                                                                            |
| D8  | Budget / scale      | **Hobby tier: < US$50/month**, a few hundred active players and tens of concurrent games. Pay-per-use only (no NAT gateways, no always-on DB)                                                                                                                                                                                    |
| D9  | Hosting             | AWS, serverless wherever possible                                                                                                                                                                                                                                                                                                |
| D10 | Interaction model   | **Direct manipulation first** (click, drag, pinch, long-press) on every client. The text console is a secondary, toggleable escape hatch for state changes the UI can't handle yet                                                                                                                                               |
| D11 | Name & domain       | **Torn Signpost**, hosted at **tornsignpost.org** (domain already registered in Route 53)                                                                                                                                                                                                                                        |
| D12 | Formats at launch   | **Standard** (all legal cards), **V5**, **Duel**                                                                                                                                                                                                                                                                                 |
| D13 | Ratings             | **Aggregate stats only** — no Elo-style rating                                                                                                                                                                                                                                                                                   |
| D14 | Moderation          | **Admins only**                                                                                                                                                                                                                                                                                                                  |
| D15 | Mac distribution    | **Signed and notarised direct download** first; **Mac App Store** later. The app is sandbox-compatible from day one                                                                                                                                                                                                              |
| D16 | Card images         | Reuse the existing full card scans from `static.deckserver.net/images/`. Code-generated card rendering is an optional later step (DECK-09)                                                                                                                                                                                       |
| D17 | Source              | **Open source under AGPL-3.0**. WoD IP is excluded from the code licence and kept out of the repository (LEGAL-08)                                                                                                                                                                                                               |
| D18 | IP licence          | World of Darkness / VTES IP (card images, text, names, clans, logos) is used under Paradox's **[Dark Pack Agreement](https://www.paradoxinteractive.com/games/world-of-darkness/community/dark-pack-agreement)**: **strictly non-commercial**, free for everyone, with the required logo and notices (§4.8). Donations only (Q9) |

## 3. Users & roles

| Role                 | Description                                                                                                                                                |
|----------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Guest                | Read-only: browses the card database, views public deck listings and views the public state of public games. Cannot chat or interact with games in any way |
| Player               | Registered user: builds decks, joins and plays games, chats                                                                                                |
| Judge                | Can be called into a game to rule on disputes, view hidden info (with audit) and correct state                                                             |
| Tournament organiser | Creates and runs tournaments, seats rounds, records results, reports to VEKN                                                                               |
| Admin                | The only moderators: review reports, mute/ban, user management, card data updates, feature flags                                                           |

## 4. Functional requirements

Priority: **M** = must have for MVP, **S** = should have for MVP, **C** = could have / post-MVP.

### 4.1 Gameplay — core (GAME)

| ID      | Requirement                                                                                                                                                                                                                                                                                                                                                                                                       | Pri |
|---------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-----|
| GAME-01 | Table size max 5. Public Standard games seat 5; 4-player tables only in private games and tournament rounds; 2-player games only in the Duel format. Predator/prey relationships always follow the **physical seating** (prey to the left, predator to the right) and are recalculated as players are ousted | M |
| GAME-02 | Full zone model per player: crypt, library, hand, uncontrolled region, ready region (controlled), torpor, ash heap, removed from game, research/out-of-play areas                                                                                                                                                                                                                                                 | M   |
| GAME-03 | Card state: locked/unlocked, contested, counters (blood, life, generic), attached cards, capacity, controller vs owner, **face-down** (identity hidden from everyone except the owning player; a judge can reveal on demand, audited)                                                                                                                                                                             | M   |
| GAME-04 | Pool (start 30), Edge, victory points, game wins, transfers per turn                                                                                                                                                                                                                                                                                                                                              | M   |
| GAME-05 | Turn structure: Unlock → Master → Minion → Influence → Discard phases, with the engine tracking the current phase and turn holder                                                                                                                                                                                                                                                                                 | M   |
| GAME-06 | Guided action flow: declare action → (optional) block window per eligible player → combat → resolution, with reaction windows. Players may skip or override at any step                                                                                                                                                                                                                                           | M   |
| GAME-07 | Combat sequence support: range, strikes, damage, prevention, presses, rounds                                                                                                                                                                                                                                                                                                                                      | S   |
| GAME-08 | Ousting detection (pool ≤ 0) with automatic VP/predator-prey reassignment                                                                                                                                                                                                                                                                                                                                         | M   |
| GAME-09 | Withdrawal, timeouts and game-end handling (time limit, VP split, GW calculation)                                                                                                                                                                                                                                                                                                                                 | M   |
| GAME-10 | Free-form override: any player can move, lock or adjust counters on their own cards; anything else asks permission from, or notifies, the affected players                                                                                                                                                                                                                                                        | M   |
| GAME-11 | **No undo — confirmation instead**: actions that reveal information or affect other players require an explicit confirm step before they commit. Once information is public it cannot be undone; mistakes are corrected with a new, logged action (UI or console)                                                                                                                                                 | M   |
| GAME-12 | Full game log with human-readable events; chat interleaved                                                                                                                                                                                                                                                                                                                                                        | M   |
| GAME-13 | **Command console** (secondary, toggled on by the user, hidden by default): a text console for changing game state when the UI or automation can't yet handle a situation. Console commands become the same engine commands the UI produces, so they follow GAME-10 permissions, appear in the game log, and are visible to every player. Available on every client, with autocomplete for card names and targets | M   |
| GAME-14 | Per-card automation hooks (e.g. auto-apply "+1 bleed"), added incrementally and data-driven where possible                                                                                                                                                                                                                                                                                                        | C   |
| GAME-15 | Hidden information is enforced by the server: players only receive their own hand/library contents; shuffles use a server-side cryptographic RNG                                                                                                                                                                                                                                                                  | M   |
| GAME-16 | Spectating: anyone, including guests, can view public games, seeing public information only (no hands, libraries or face-down identities). Spectators cannot chat or interact                                                                                                                                                                                                                                     | M   |
| GAME-17 | Replay of completed games from the event log                                                                                                                                                                                                                                                                                                                                                                      | C   |
| GAME-18 | **Judge call**: any player at the table can call a judge (e.g. slow play, rules dispute). A judge call **pauses the table timer** until the judge resolves it. Judges can rule, correct state (audited) and apply the outcome of a slow-play ruling | M |
| GAME-19 | **Player replacement**: in a non-tournament game an admin (not necessarily a judge) can replace a seat's player with a willing player. The new player takes ownership of every card the previous player owned, plus the seat's hand, library, crypt, pool and VP, so a game isn't stalled by a player who doesn't return | M |
| GAME-20 | **Turn direction**: play normally passes to your prey when your turn ends; some cards reverse the play order. The only effect of a reversal is which player takes the next turn; predator/prey (left = prey, right = predator) and impulse order always follow the physical seating | M |
| GAME-21 | **Ousted on your own turn**: the turn ends, the ousted player can take no further part, and play passes to the next player from the ousted seat's position after the effect that ousted them finishes resolving: any combat involving them ends and the current action ends (architecture DQ9, following zero-vtes's VEKN-ruling-based rules) | M |

### 4.2 Tempo (TEMPO)

| ID       | Requirement                                                                                                                                                                                           | Pri |
|----------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-----|
| TEMPO-01 | When the engine is waiting on a player, that player is notified (in-app, email/push per preferences) and can respond whenever convenient                                                              | M   |
| TEMPO-02 | Live mode: all connected clients see changes in under 500 ms (p95)                                                                                                                                    | M   |
| TEMPO-03 | Games default to real time. When the engine needs input from an offline player, the game halts on that decision only and resumes in real time once the player responds. No explicit async/live switch | M   |
| TEMPO-04 | **Async response deadline**: a game is *async* whenever not all players are present at the table. A decision owned by an absent player gets a response deadline (default **24 h**) with a reminder. When the deadline passes, nothing is decided automatically: a judge call is raised and a judge rules. The table timer is paused while a game is async. Game creators can change the default; tournament organisers can override it for a whole tournament or for specific date ranges (e.g. holidays) | M |
| TEMPO-05 | **Real-time table timer**: while all players are present there are **no per-decision deadlines**. The table runs a global timer (default **2 h**, e.g. a tournament round). Anyone at the table can call a judge if they think a player is taking too long | M |
| TEMPO-06 | Presence: who is currently viewing the game                                                                                                                                                           | S   |
| TEMPO-07 | Vacation/away status that pauses async deadlines                                                                                                                                                      | C   |

### 4.3 Notifications (NOTIF)

| ID       | Requirement                                                                                  | Pri |
|----------|----------------------------------------------------------------------------------------------|-----|
| NOTIF-01 | In-app notifications (badge/list) for "your turn", "block opportunity", "you were mentioned" | M   |
| NOTIF-02 | Email notifications with per-user preferences and digest options                             | M   |
| NOTIF-03 | Web Push (PWA) and APNs (Mac/iOS)                                                            | S   |
| NOTIF-04 | Discord webhook per game or tournament (opt-in)                                              | C   |

### 4.4 Cards & decks (DECK)

| ID      | Requirement                                                                                                                                                                                                                                                  | Pri |
|---------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-----|
| DECK-01 | Card database sourced from official VEKN data (or KRCG), updatable by admin without a deploy                                                                                                                                                                 | M   |
| DECK-02 | Fast card search: name (fuzzy), type, clan, discipline, sect, capacity, group, text                                                                                                                                                                          | M   |
| DECK-03 | Deck builder: crypt and library editing, counts, notes, private/public visibility. Public decks can be browsed by anyone, including guests                                                                                                                   | M   |
| DECK-04 | Validation per format: **Standard** (all legal cards; crypt ≥12, library 60–90, grouping, banned list), **V5** (V5 card pool), **Duel**. Custom/limited formats post-MVP                                                                                     | M   |
| DECK-05 | Import/export: plain text (TWDA style), VDB, Amaranth, vtesdecks/KRCG JSON, URL import                                                                                                                                                                       | M   |
| DECK-06 | Deck stats: discipline/clan spread, capacity curve, card type breakdown                                                                                                                                                                                      | S   |
| DECK-07 | Deck versioning (the exact version played in each game is recorded)                                                                                                                                                                                          | S   |
| DECK-08 | Card images: full card scans from `static.deckserver.net/images/`, mirrored into Torn Signpost's own S3/CloudFront so we don't depend on deckserver's availability or bandwidth. Responsive sizes (thumbnail/full) generated at mirror time                  | M   |
| DECK-09 | **Generated card rendering** (optional): extract the artwork from the scans and draw each card's layout in code for every card type and variant, so a card shows its *current* state (modified disciplines, capacity, clan, etc.). Scans remain the fallback | C   |

### 4.5 Lobby, social and chat (LOBBY)

| ID       | Requirement                                                                                                                                  | Pri |
|----------|----------------------------------------------------------------------------------------------------------------------------------------------|-----|
| LOBBY-01 | Create game: format, seats (per GAME-01), invite-only/public, response deadlines, ranked/casual                                              | M   |
| LOBBY-02 | Join/leave, choose deck, ready check, seat randomisation                                                                                     | M   |
| LOBBY-03 | Global chat and in-game chat with @mentions                                                                                                  | M   |
| LOBBY-04 | Player profiles: display name, avatar, VEKN ID, stats, preferences                                                                           | M   |
| LOBBY-05 | Moderation: players can report, and mute/block others for themselves; admins (the only moderators) review a report queue and can mute or ban | M   |
| LOBBY-06 | Friends/following and private messages                                                                                                       | C   |

### 4.6 Tournaments (TOURN)

| ID       | Requirement                                                                                              | Pri |
|----------|----------------------------------------------------------------------------------------------------------|-----|
| TOURN-01 | Create a tournament: format, rounds, final, table time limit, registration window, async response deadline with date-range overrides (TEMPO-04) | M |
| TOURN-02 | Registration with decklist submission and deck lock                                                      | M   |
| TOURN-03 | Seating per round that follows VEKN seating rules (port of the existing solver)                          | M   |
| TOURN-04 | Automatic creation of round games from the seating                                                       | M   |
| TOURN-05 | Result recording: GW, VP, TP, standings and tie-breaks; organiser can correct results                    | M   |
| TOURN-06 | Finals seating by standings, with seat choice                                                            | S   |
| TOURN-07 | VEKN-compatible results export (archon format)                                                           | S   |
| TOURN-08 | **Judge call** from inside any game (GAME-18); in tournaments it goes to the tournament's judges | S |

### 4.7 Stats (STATS)

Aggregate statistics only. There is no Elo-style rating (D13).

| ID       | Requirement                                                            | Pri |
|----------|------------------------------------------------------------------------|-----|
| STATS-01 | Record results for every completed game (GW, VP, seat, deck, duration) | M   |
| STATS-02 | Player stats: games, GW/VP rates, favourite clans/decks                | M   |
| STATS-03 | Leaderboards of aggregate stats (GW, VP, win rate), seasonal           | S   |
| STATS-04 | Card/deck meta stats (play rates, win rates)                           | C   |

### 4.8 Licensing compliance and donations (LEGAL)

Paradox Interactive owns the World of Darkness IP. Torn Signpost uses it under the Dark Pack Agreement,
which Paradox can end at any time for any reason.

| ID       | Requirement                                                                                                                                                                                                                                                                           | Pri |
|----------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-----|
| LEGAL-01 | Every client (web, macOS, future iOS) shows the **Dark Pack logo** (official assets, unaltered) in a persistent footer/About screen and on the landing/sign-in page                                                                                                                   | M   |
| LEGAL-02 | The exact notice appears alongside the logo: *"Portions of the materials are the copyrights and trademarks of Paradox Interactive AB, and are used with permission. All rights reserved. For more information please visit worldofdarkness.com."*                                     | M   |
| LEGAL-03 | A clear statement that Torn Signpost is **not official World of Darkness material** and is not affiliated with or endorsed by Paradox Interactive, Black Chantry Productions or the VEKN                                                                                              | M   |
| LEGAL-04 | Promotional material (app store listings, social media, Discord, README) carries the logo and notice                                                                                                                                                                                  | M   |
| LEGAL-05 | **Free for everyone**: no paid features, subscriptions, in-app purchases, paid tiers, ads or selling of any goods/services. No feature or content is gated behind payment                                                                                                             | M   |
| LEGAL-06 | Voluntary **donations** to cover time and hosting via any donation platform that pays out to Australia (e.g. GitHub Sponsors, Ko-fi, Patreon; confirm Australian payout support at setup), linked from the website. Recognition only (e.g. a supporter badge), never functional perks | S   |
| LEGAL-07 | App Store builds follow Apple's rules on donations (the donation link may be left out of App Store builds); the apps themselves are free with no in-app purchases                                                                                                                     | M   |
| LEGAL-08 | **Removable IP**: WoD assets (images, card text, logos) live in a separately deployed content pack, not in the open-source repository. If the agreement ends, the content can be withdrawn without code changes                                                                       | M   |
| LEGAL-09 | Terms of Use and Privacy Policy pages, including the IP notice and the code's open-source licence                                                                                                                                                                                     | M   |

### 4.9 Accounts & identity (AUTH)

| ID      | Requirement                                                                                                  | Pri |
|---------|--------------------------------------------------------------------------------------------------------------|-----|
| AUTH-01 | Sign up/in with email and password (verification, reset)                                                     | M   |
| AUTH-02 | Sign in with Google and Apple (Apple is required for App Store builds that offer social login)               | M   |
| AUTH-03 | *(Optional)* Link a VEKN ID to a profile. Verification method to be decided once VEKN details are known (Q2) | C   |
| AUTH-04 | Account deletion and data export (GDPR-style)                                                                | M   |
| AUTH-05 | Unique display names and handle changes                                                                      | M   |

## 5. Platform requirements (PLAT)

| ID      | Requirement                                                                                                                                                                                                                                                                                                            | Pri |
|---------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-----|
| PLAT-01 | **Web**: responsive React app that is fully playable from 360px phones up to large desktops. Layouts adapt (phone: focused single-player view plus a table overview; desktop: whole table)                                                                                                                             | M   |
| PLAT-02 | **PWA**: installable, offline card database and deck builder, web push                                                                                                                                                                                                                                                 | S   |
| PLAT-03 | **macOS**: native SwiftUI app (macOS 14+) with full gameplay, deck builder, notifications (APNs), menu bar/Dock badge, keyboard shortcuts. Always code-signed and notarised. Ships first as a direct download from tornsignpost.org with in-app updates, then on the Mac App Store; App Sandbox compliant from day one | M   |
| PLAT-04 | **iOS/iPadOS**: SwiftUI app sharing most code with macOS                                                                                                                                                                                                                                                               | C   |
| PLAT-05 | **Android**: PWA first; native app only if demand appears                                                                                                                                                                                                                                                              | C   |
| PLAT-06 | All clients use the same versioned public API and the shared rules engine                                                                                                                                                                                                                                              | M   |
| PLAT-07 | Touch, mouse, trackpad and keyboard input. The direct-manipulation interaction model in §5.1 applies to every client                                                                                                                                                                                                   | M   |

### 5.1 Interaction model (UX)

Play is driven by direct manipulation, the way people expect modern digital card games to feel.
The command console (GAME-13) is an escape hatch, not the main interface.

| ID    | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Pri |
|-------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-----|
| UX-01 | Every common game operation can be done without typing: play, move, lock/unlock, influence, attach, burn, adjust counters, draw, discard, declare actions and blocks                                                                                                                                                                                                                                                                                                 | M   |
| UX-02 | Drag-and-drop cards between zones and onto targets (attach to a minion, aim at a prey), with valid drop targets highlighted while dragging                                                                                                                                                                                                                                                                                                                           | M   |
| UX-03 | **Contextual action toolbar is the primary driver**: it shows only the actions valid for this player right now (e.g. acting in minion phase: Bleed, Hunt, Political Action, Equip, Recruit, Employ...; in a block window: Block / Decline; in a reaction window: React / Pass). Picking an action then prompts the player to select the minion and/or card(s) and targets it needs, highlighting only valid choices. Valid actions are computed by the shared engine | M   |
| UX-04 | Context menus (right-click on desktop, long-press on touch) as a secondary shortcut to the same actions                                                                                                                                                                                                                                                                                                                                                              | S   |
| UX-05 | Pinch-to-zoom and pan around the table (touch and trackpad), plus scroll-wheel zoom and keyboard shortcuts on desktop                                                                                                                                                                                                                                                                                                                                                | M   |
| UX-06 | Card inspection: hover (desktop) or press-and-hold (touch) shows a full-size card with its text and current state                                                                                                                                                                                                                                                                                                                                                    | M   |
| UX-07 | Counter adjustment by tap/drag/scroll on the counter (e.g. move blood between pool and a vampire by dragging)                                                                                                                                                                                                                                                                                                                                                        | M   |
| UX-08 | Animated state changes (moves, locks, damage, shuffles) so players can follow what other players did. Animations can be reduced (reduced-motion setting)                                                                                                                                                                                                                                                                                                             | M   |
| UX-09 | Prompts for pending decisions (block?, reaction?, confirm override?) appear as non-blocking, clearly owned UI with timers where relevant                                                                                                                                                                                                                                                                                                                             | M   |
| UX-10 | Native feel per platform: SwiftUI gestures, haptics on iOS, trackpad gestures and menu commands on macOS, pointer/touch events on the web                                                                                                                                                                                                                                                                                                                            | M   |
| UX-11 | Optimistic local updates: the client applies its own action at once through the shared engine and reconciles when the server confirms                                                                                                                                                                                                                                                                                                                                | S   |
| UX-12 | Command console (GAME-13): toggle via keyboard shortcut or a menu, docked panel on desktop, slide-up sheet on mobile                                                                                                                                                                                                                                                                                                                                                 | M   |

## 6. Non-functional requirements (NFR)

| ID     | Requirement                                                                                                                                                       |
|--------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| NFR-01 | **Cost**: < US$50/month at hobby scale. Scale-to-zero, pay-per-use services only. Cost alarms at 50%/80%/100% of budget                                           |
| NFR-02 | **Latency**: live action → other clients p95 < 500 ms; API p95 < 300 ms warm; cold starts kept under 1 s                                                          |
| NFR-03 | **Availability**: 99.5% target. A failure in one game must never corrupt or lose another game's state                                                             |
| NFR-04 | **Consistency**: game state changes are serialised per game (no lost updates under concurrent actions). Event-sourced log as the source of truth                  |
| NFR-05 | **Security**: server-authoritative state, hidden-information redaction, input validation via the shared engine, OWASP ASVS L1, rate limiting, least-privilege IAM |
| NFR-06 | **Privacy**: minimal PII (email, display name). Email is never shown to other players                                                                             |
| NFR-07 | **Accessibility**: WCAG 2.1 AA for the web, VoiceOver support on Apple, colour-blind-safe indicators                                                              |
| NFR-08 | **i18n**: UI strings externalised from day one. English at launch; other locales (e.g. Spanish, French) added later                                               |
| NFR-09 | **Observability**: structured logs, traces, per-game error correlation, dashboards, alarms                                                                        |
| NFR-10 | **Delivery**: infrastructure as code, CI/CD with preview environments, automated tests (engine unit/property tests, API integration, E2E)                         |
| NFR-11 | **Data retention**: completed game logs kept indefinitely (stats/replay); chat retention configurable                                                             |
| NFR-12 | **Backups**: point-in-time recovery for primary data stores                                                                                                       |

## 7. Out of scope (for now)

- Migrating data, accounts or game history from deckserver.net/JOL
- Full card-by-card rules enforcement / AI opponents
- Native Android app
- Any commercial activity: paid features, subscriptions, in-app purchases, ads, merchandise (prohibited by the Dark Pack Agreement). Donations are the only exception (LEGAL-06)
- Voice/video chat (players can use Discord)

## 8. Open questions

| #   | Question                | Status                                                                                                                                                    |
|-----|-------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------|
| Q1  | Card images & licensing | **Resolved**: images may be used under the Dark Pack Agreement (D18, §4.8); reuse deckserver scans (D16, DECK-08). Generated rendering optional (DECK-09) |
| Q2  | VEKN ID verification    | **Deferred**: Shannon gathering VEKN details. AUTH-03 is optional until then                                                                              |
| Q3  | Product name and domain | **Resolved**: Torn Signpost, tornsignpost.org (D11)                                                                                                       |
| Q4  | Mac distribution        | **Resolved**: signed direct download now, Mac App Store later (D15)                                                                                       |
| Q5  | Formats at launch       | **Resolved**: Standard, V5, Duel (D12)                                                                                                                    |
| Q6  | Rating system           | **Resolved**: aggregate stats only (D13)                                                                                                                  |
| Q7  | Moderation              | **Resolved**: admins only (D14)                                                                                                                           |
| Q8  | Open-source licence     | **Resolved**: AGPL-3.0 (D17)                                                                                                                              |
| Q9  | Donations               | **Resolved**: any donation platform that works in Australia (LEGAL-06)                                                                                    |
| Q10 | Product name            | **Resolved**: name is fine (other VTES apps set the precedent). The focus is meeting the Dark Pack conditions (§4.8)                                      |

## 9. Next phase

After sign-off: **Phase 2 — Architecture & design** (`docs/02-architecture.md`) covering:
the AWS serverless topology (API Gateway HTTP + WebSocket or AppSync Events, Lambda, DynamoDB
single-table, S3/CloudFront, Cognito, EventBridge Scheduler, SES/SNS), the event-sourced game
model and per-game concurrency control, the shared engine package API and its JavaScriptCore
embedding, client architectures (React web, SwiftUI), monorepo layout, CI/CD and environments,
and a cost model checked against NFR-01.
