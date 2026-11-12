# Torn Signpost

A free, open-source platform for playing *Vampire: The Eternal Struggle* online, in real time or
play-by-post, from a phone, a browser or a Mac. Live beta at <https://tornsignpost.org>.

> Portions of the materials are the copyrights and trademarks of Paradox Interactive AB, and are
> used with permission. All rights reserved. For more information please visit worldofdarkness.com.
>
> Torn Signpost is not official World of Darkness material. It is a non-commercial fan project
> under the [Dark Pack Agreement](https://www.paradoxinteractive.com/games/world-of-darkness/community/dark-pack-agreement).

## Documentation

- [Requirements](docs/01-requirements.md)
- [Architecture & design](docs/02-architecture.md)
- [Command console](docs/console.md)
- [Structured flow: phases, actions and windows](docs/flow.md)
- [Roles and privileges: players, judges, admins](docs/roles.md)
- [Testing](docs/testing.md)

## Repository layout

| Path | Contents |
|---|---|
| `packages/engine` | Pure TypeScript rules engine shared by server and clients |
| `packages/protocol` | API and message schemas (Zod) |
| `services/backend` | AWS Lambda handlers, plus a local server for development |
| `apps/web` | React web client (PWA) |
| `infra` | AWS CDK app |
| `packages/cards` | Card records, search, deck import/export, validation and stats |
| `tools/sandbox` | Terminal sandbox for playing the engine locally |
| `tools/content-ingest` | Builds and publishes the content pack (card data and images) |
| `local-dev` | Docker Compose for DynamoDB Local |

## Development

Requires Node.js 22+, pnpm and Docker.

```sh
pnpm install
pnpm check        # Biome lint + format check
pnpm typecheck
pnpm test
```

### Card data (admins)

Card data and images are never committed (LEGAL-08). They're built from KRCG and the deckserver
scans, then published to the content bucket:

```sh
pnpm content:ingest                     # build card data into content-pack/ (git-ignored)
pnpm content:ingest --images --publish  # mirror scans and publish (needs AWS credentials)
```

### Running locally

Everything runs on your machine without touching AWS:

```sh
pnpm dev          # DynamoDB Local (Docker), API on :3001, web on http://localhost:5173
pnpm db:down      # stop DynamoDB Local (data is kept in a Docker volume)
pnpm db:reset     # wipe DynamoDB Local (deletes the volume) and recreate an empty table
pnpm sandbox      # play the engine in the terminal as any seat, judge or admin
```

- `pnpm dev` runs the same Hono app that Lambda runs, as a local Node server with auto-reload,
  against a `ts-local-main` table in DynamoDB Local. The local DynamoDB client always uses the
  local endpoint and dummy credentials, so it can't reach the real account.
- Locally, use `Authorization: Bearer dev:<user>` (e.g. `dev:alice`, or `dev:jo:judge` for a
  judge) instead of signing in. WebSockets connect to `ws://localhost:3001/ws?token=dev:alice`.
- Backend integration tests run against DynamoDB Local in throwaway tables. Start it with
  `pnpm db:up`; without it they're skipped locally (CI always runs them).
- Feature flags are all on locally (`apps/web/vite.config.ts`); on the beta, every one but `replay`
  is on too (`infra/lib/config.ts`). They are `replay`, the scenario player at
  http://localhost:5173/replay (it runs in the browser and needs only the web server and card
  content), `presence`, the presence dots and live/async status at the table, `clock`, the table
  timer, pauses, deadline countdowns and the timer settings when creating a game, `judgeCalls`,
  calling a judge, the ruling tools and the judge queue at /judge (sign in as `jo:judge` to try
  it), `notifications`, the bell in the header, `email`, the email settings on the Account page,
  and `stats`, players' pages and the leaderboards. Locally, emails are printed by the API process (dev users
  are `<name>@example.test`), never sent. Locally, timers (such as the 30 s absence check) run in the API process.
- Results and stats can be rebuilt from the finished games' event logs (after a change to how they
  are counted, or to backfill): `TABLE_NAME=ts-local-main DYNAMODB_ENDPOINT=http://localhost:8000
  pnpm --filter @torn-signpost/backend stats:rebuild`; against the beta, set `TABLE_NAME=ts-beta-main`
  and leave out `DYNAMODB_ENDPOINT` (it uses your AWS credentials). It also records each finished
  game's result for the lobby's recent results, for games finished before that was kept.
- To clear out test games, `pnpm --filter @torn-signpost/backend games:clear` (same `TABLE_NAME`
  and `DYNAMODB_ENDPOINT` as above) deletes every game, with its log, chat and result, the judge
  and admin queues, notifications, and every player's game history and stats. Accounts, handles,
  email settings and decks stay. It only lists what it would delete until you add `--yes`, and
  refuses while anyone has a game open. Stats are empty afterwards: no rebuild needed.
- To point the local web client at the live beta API instead:
  `TS_API_URL=https://api.tornsignpost.org pnpm dev:web`.
- Storybook: `pnpm --filter @torn-signpost/web storybook` (http://localhost:6006) has stories for
  the web components (`apps/web/src/**/*.stories.tsx`). Game stories run the engine's scenarios
  in the browser, as the Replay page does, at a chosen line and from a chosen seat; they're
  playable from there, and the Actions panel shows each command sent. Card data and images come
  from the content CDN through Storybook's `/content` proxy (`TS_CONTENT_URL` to change it).
  Helpers are in `apps/web/src/stories/fixtures.tsx`.
- The sandbox starts a three-player table with invented test cards. Type `.help` for commands,
  `.as B` to switch seats, `.save file.scenario` to keep the session as a golden scenario.
  Options: `--scenario <file>`, `--catalog <cards.json>` or `--real` (the local content pack),
  `--seed <n>`; `.find <name>` lists card IDs. Console syntax:
  [docs/console.md](docs/console.md).

Deploying (maintainers): `pnpm deploy` builds everything and runs `cdk deploy --all` against the
AWS account in your environment. CI deploys `main` automatically via GitHub OIDC.

Email (maintainers): the `Email` stack sets up SES for `tornsignpost.org` (DKIM, a
`mail.tornsignpost.org` MAIL FROM domain, DMARC) and sends as `notifications@tornsignpost.org`.
SES starts in the sandbox, where it only sends to verified addresses. To send to players, request
production access once: AWS console → SES (us-east-1) → Account dashboard → Request production
access; mail type *Transactional*, website `https://tornsignpost.org`, and describe game
notifications that players opt into, sent only while they're away, with one-click unsubscribe,
and bounces and complaints suppressed automatically.

## Licence

Code: [AGPL-3.0-only](LICENSE). World of Darkness material is excluded from the licence and from
this repository; see [NOTICE](NOTICE).
