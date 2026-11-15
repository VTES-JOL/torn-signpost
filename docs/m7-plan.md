# M7 plan: tournaments, run through Archon

M7 runs VEKN tournaments on the platform. **Archon**, the VEKN's tournament manager, runs the
tournament: the table draw, scores, standings, finals and the report to the VEKN. **Torn Signpost**
registers players and their decks, plays each round's tables as games, and sends each table's
result back to Archon. Roadmap: "Registration, seating, rounds, standings, archon export, judge
calls" (architecture §13; TOURN-01..08); decided 2026-11-15: everything but the games goes through
Archon's API, registration starts here.

Archon's test server is **archon.krcg.org**; production is archon.vekn.net. What's below about its
API comes from the test server's web app (2026-11-15: its endpoints, OAuth flow and
`src/lib/tournament-actions.ts`, `src/lib/engine.ts` from the published source maps); the server's
own API reference isn't public, so the first increment checks the parts we rely on.

## What Archon offers

| Need | Archon |
|---|---|
| Who we are | An **OAuth 2.0 client** (authorization code with PKCE), registered in Archon's Developer Portal by an Archon administrator (`manage_oauth_clients`), with redirect URIs and a client secret; `/oauth/authorize`, `/oauth/token`, consents a member can revoke |
| Acting for an organiser | Scope **`event:run`**, granted **for one tournament** by its organiser (the consent names the tournament) |
| Who a player is | Scope **`profile:read`** (and `profile:email`): their Archon member, with their VEKN number |
| Reading a tournament | `GET /api/tournaments/{uid}`; a server-sent event stream (`/stream`) for live updates |
| Changing a tournament | `POST /api/tournaments/{uid}/action` with `{type, ...}`: `Register`, `AddPlayer`, `Unregister`, `DropOut`, `CheckIn`, `CheckInAll`, `UpsertDeck`, `StartRound` (with or without a `seating`), `AlterSeating`, `SwapSeats`, `SetScore {round, table, scores: [{player_uid, vp}]}`, `Override`, `FinishRound`, `SetToss`/`RandomToss`, `StartFinals`, `FinishFinals`, `FinishTournament`, … |
| Scoring | GW and TP from the VPs, exactly as the VEKN rules (3.7); a table's VPs are validated (`incomplete`, `excessive_total`, `impossible_oust_order`, `half_vp_mismatch`…) |
| Seating | Its own seating engine (R1–R9), run when a round starts |
| Also | The round timer, judge calls, announcements, sanctions, the Archon file (`archon-template`), the VEKN report, ratings |

## Spike findings (archon.krcg.org, 2026-11-15)

Checked with our registered client against a test tournament (`Torn Signpost Test`,
01a1ded8-1308-74b9-8ae1-2d9efffcf376):

- **Client credentials** (`grant_type=client_credentials`, id and secret in the form body; HTTP
  Basic is refused) give an hour's `api:read` token. It reads nothing we need: the public
  snapshot (`/snapshot`, anonymous, NDJSON) has tournament summaries only, no players or rounds.
- **Authorization code with PKCE**: the person opens `/consent?response_type=code&client_id=…
  &redirect_uri=…&scope=…&state=…&code_challenge=…&code_challenge_method=S256[&tournament=<uid>]`;
  Archon's login comes first if needed. `POST /oauth/token` (form body: `authorization_code`,
  `code`, `redirect_uri`, `client_id`, `client_secret`, `code_verifier`) gives an access token
  (JWT, one hour) and a refresh token. **Refresh tokens rotate**: each refresh returns a new one.
- **`profile:read`**: `GET /oauth/userinfo` gives `sub` (the Archon uid), `roles`, `vekn_id`,
  `capabilities`; no name. The token reaches nothing else ("This token names no event").
- **`event:run` for a tournament**: the token's claims carry `tournament`; any other route or
  tournament is refused ("This token acts only on the tournament it was granted for").
  - **Read**: `GET /stream?tournament=<uid>` with the bearer token is a server-sent event stream:
    the tournament's full state (`players` with `user_uid`, `state`, `result {gw, vp, tp}`,
    `missing_decklist`…; `rounds`; `standings`; `finals`; `timer`; config such as `round_time`,
    `max_rounds`, `multideck`), then the `users` it names (member records, with contact
    details: keep only uid, name and VEKN number), then `sync_complete`. Read to there and close.
    `GET /api/tournaments/<uid>/decks` gives the decks. There is no plain GET of a tournament.
  - **Act**: `POST /api/tournaments/<uid>/action` with `{type, …}`; 201 with the tournament's
    summary, or 400 with `{detail, code, params}` (`tournament.wrong_state` with `expected` and
    `current`, `tournament.not_enough_players`…).
  - **States**: Planned → `OpenRegistration` → Registration → `CloseRegistration` → Waiting
    (check-in: `CheckIn {player_uid}`) → `StartRound` (at least 4 checked in) → Playing →
    `FinishRound` → Waiting → … → `StartFinals`.
  - **Players must be Archon members with a VEKN number**: `AddPlayer {user_uid}` (404 for an
    unknown uid; 400 `tournament.vekn_id_required` without a VEKN number; a name-only player is for
    Archon's offline mode only). A Prince can sponsor a member for a number. So registering here
    needs a linked account **with** a VEKN number (`/oauth/userinfo`'s `vekn_id`): check it
    before sending `Register`. `UpsertDeck {player_uid, deck: {name, comments, cards: {<VEKN id>:
    count}}}` takes VEKN card ids, as ours.
  - **`StartRound` without a seating: Archon draws the tables** (confirmed with four players:
    one table, the tournament in Playing, each table `In Progress`).
  - **Rounds and tables count from 0** in actions: `SetScore {round: 0, table: 0, scores:
    [{player_uid, vp}]}` (1 is `tournament.invalid_round`). Pages show them from 1.
  - **`SetScore` records any VPs**: an impossible table (four players on 2 VP) is accepted (201)
    and the table marked `Invalid`; a valid one marks it `Finished`, with GW and TP computed to
    3.7 (a 4-player table: 60, 48, then 18 each for two tied last). So after sending a score we
    read the table's state back, and show `Invalid` to the tournament's officials.
  - **`FinishRound`** is refused while a table isn't finished (`tournament.tables_not_finished`,
    with the tables); once done, the tournament is back in Waiting with `standings` (`gw`, `vp`,
    `tp`, `toss`, `finalist`, `withdrawn`, `disqualified`).

## How the work divides

| | Torn Signpost | Archon |
|---|---|---|
| The tournament | Linked to an Archon tournament by its organiser | Created, configured and finished there |
| Players | Register here: an account linked to Archon, a deck chosen and locked | The player list, check-in, drops, sanctions |
| Decks | Chosen from the player's decks here, sent with `UpsertDeck` | Kept, published after the event if the organiser wants |
| Rounds | A game per table, as soon as a round starts | The table draw, starting and finishing rounds |
| Results | Each game's VPs, sent with `SetScore` as it ends | GW, TP, standings, corrections (`Override`) |
| Finals | The final table as a game | The top five, ties, the finals seating |
| Judges | Judge calls inside the games, to the tournament's officials | Rulings on the tournament (sanctions, overrides) |
| Reporting | Nothing | The VEKN report and the Archon file |

## Design decisions

1. **Archon is the tournament's source of truth.** Torn Signpost keeps a link (`TOURN#<id>`:
   the Archon tournament's uid, the organiser's grant, our games per round and table) and a cached
   copy of Archon's state for its pages, never its own standings or seating.
2. **We act with the organiser's grant.** The organiser links the tournament by granting
   `event:run` for it; the backend keeps the refresh token (encrypted, KMS) and sends every action
   as the organiser. A player's own actions (registering, dropping) are sent the same way, after
   our own checks; Archon records who granted it.
3. **Players link their Archon account** (`profile:read`) from their profile, once. That gives
   their Archon uid and VEKN number. Registering for a linked tournament needs it.
4. **A round's tables become games automatically** (TOURN-04), idempotently by (tournament, round,
   table): private, tournament settings, seat order from Archon's seating (seat 1 plays first),
   the round's time limit, each player's registered deck, the tournament's officials as judges.
5. **A game's result goes back when it ends**: its `GameEnded` VPs become `SetScore` for that
   table, through an outbox that retries while Archon is unreachable and shows a rejection (an
   invalid table) to the tournament's officials. Corrections are made in Archon; we follow them.
6. **We follow Archon's state by polling** while a tournament is under way (a scheduled check
   every minute or so, and after every action we send), not by holding its stream open: the
   backend is Lambda. The stream can come later if polling proves too slow.

## Questions

| # | Question | Recommendation |
|---|---|---|
| A1 | Registering our OAuth client | **Ask Archon's administrators** for a client on archon.krcg.org now (redirect URIs for the beta and local development), and for archon.vekn.net once it works. Nothing in M7 can be tried against the real server without it |
| A2 | Who starts rounds and finals? | **Either place.** The organiser can start a round in Archon or from our tournament page, which sends `StartRound` without a seating, and Archon draws it (confirmed in the spike). Either way we create the games when we see the round |
| A3 | Players without an Archon account or VEKN number | They make an Archon account and link it; Archon refuses players without a VEKN number, which a Prince issues (sponsoring). Our registration says so before sending anything. Name-only players exist only in Archon's offline mode: **not in M7** |
| A4 | Registering in Archon too | Registration **here only** for linked tournaments: Archon's own registration is closed or ignored by the organiser, so every registered player has a Torn Signpost account, a linked Archon account and a locked deck. Players added in Archon by the organiser still need to link their account here before their games can be made |
| A5 | Live or async rounds | **The organiser's choice per tournament** (TEMPO-04/05): live rounds use the table timer (Archon's round timer is shown alongside); async rounds use a round end date and response deadlines |
| A6 | Finals seating | **Archon's.** If the VEKN procedure (3.1.3: crypt cards revealed, seat choice lowest qualifier first) isn't in Archon, it's done at the table and entered there (`AlterSeating`); we play the final as seated |
| A7 | Disqualification in a game | A judge's disqualification ruling in our game is the game's; the **sanction is issued in Archon** by its officials. Sending sanctions from here: later |
| A8 | Formats | **Constructed Standard.** Multi-deck (a deck per round, `UpsertDeck` with a round) if Archon's tournament uses it; Duel and Limited later |

## Increments

### M7.1 Connecting to Archon: done

The spike's findings are above. Built: `packages/archon` (the client: PKCE, token exchange and
refresh, `userinfo`, reading a tournament from its stream, actions with typed errors; VEKN table
scoring; a fake Archon and contract tests against the real one), linking a player's Archon
account (`/me/archon`, the Account page's "Archon account", `/archon/callback`; the Archon uid and
VEKN number kept, not the tokens), and the beta's settings (Archon's test server, the client
secret in Secrets Manager). The Account page's link is behind the `archon` flag, on locally and
dark on the beta.


- A spike against archon.krcg.org with a registered client (A1): the PKCE flow and scopes, reading
  a tournament, `StartRound` without a seating, `SetScore` with an `event:run` grant, error shapes.
  Findings recorded here.
- `packages/archon`: a typed client for the parts we use (the tournament, its actions, member
  profile), a fake Archon for tests built from the shapes the spike records, and contract tests.
- Backend: the OAuth flows (state, PKCE, token exchange, refresh), encrypted token storage,
  configuration per stage (krcg for the beta, vekn.net later).
- Profiles: **Link your Archon account** (`profile:read`): Archon uid and VEKN number on the
  profile; unlink.

### M7.2 Linking a tournament

- An organiser links an Archon tournament they run: the `event:run` grant names it; we store the
  link and fetch its state.
- Tournaments pages: upcoming, running and finished linked tournaments; a tournament's page with
  Archon's details, players, rounds and standings (from the cached state), and a link to it in
  Archon.
- Polling while it's under way (decision 6).
- `docs/roles.md`: what an organiser can do here, and the tournament's officials as judges.

### M7.3 Registration

- Register (TOURN-02): a linked account (decision 3), a deck from the player's decks checked legal
  for the format, copied and locked; sent as `Register` and `UpsertDeck`. Drop (`DropOut`);
  check-in (`CheckIn`) when Archon asks for it.
- The organiser sees who is registered and whose account or deck is missing.

### M7.4 Rounds become games

- When a round appears in Archon's state, a game per table (decision 4), players notified with a
  link to their table; the tournament page lists the round's games.
- The round's clock: live (time limit) or async (end date), A5.
- Judge calls from a tournament game go to the tournament's officials (TOURN-08).

### M7.5 Results

- `GameEnded` → `SetScore` through the outbox (decision 5); the table's state on our page (sent,
  accepted, rejected and why).
- A game that ends by a judge's ruling (time limit, disqualification) sends what the game scored;
  odd tables are validated in Archon (`Override`).
- The round finishes in Archon (`FinishRound`), by the organiser or from our page once every table
  is in.

### M7.6 Finals

- The final, once Archon seats it (`StartFinals`, ties by `RandomToss`/`SetToss` there): a game
  with Archon's seating, its result by `SetScore`, `FinishFinals`.
- The tournament's result on our page, from Archon; the report to the VEKN is Archon's.

## Order and size

| # | Increment | Depends on | Rough size |
|---|---|---|---|
| 1 | Connecting to Archon | A1 (a client) | 2–3 days, plus waiting on A1 |
| 2 | Linking a tournament | 1 | 2 days |
| 3 | Registration | 2 | 1–2 days |
| 4 | Rounds become games | 2 | 2–3 days |
| 5 | Results | 4 | 1–2 days |
| 6 | Finals | 5 | 1 day |

Ask for the client (A1) first. The fake Archon lets 2–6 be built and tested while we wait; the spike
confirms the shapes before anything reaches the beta.

## What this replaces

The first draft of this plan (2026-11-15) ran tournaments here: our own seating solver (a port of
`tournament-seating`), scoring, standings and an Archon file export. Archon already does all of
that, to the VEKN's rules and with its reporting, so none of it is built: no `packages/seating` or
tournament scoring package. Requirements TOURN-03, -05, -06 and -07 are met through Archon.

## Docs to update as each lands

`docs/02-architecture.md` (§4 API, §5.3 store keys, §5.6 linked accounts, §5.7 rewritten for Archon,
§13 roadmap), `docs/01-requirements.md` (TOURN-01..07 delivered through Archon),
`docs/roles.md` (organisers and tournament officials), `docs/flow.md` (tournament game settings,
judge routing) and `docs/testing.md` (the fake Archon and the contract tests).
