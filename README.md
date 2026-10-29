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

## Repository layout

| Path | Contents |
|---|---|
| `packages/engine` | Pure TypeScript rules engine shared by server and clients |
| `packages/protocol` | API and message schemas (Zod) |
| `services/backend` | AWS Lambda handlers, plus a local server for development |
| `apps/web` | React web client (PWA) |
| `infra` | AWS CDK app |
| `tools/sandbox` | Terminal sandbox for playing the engine locally |
| `local-dev` | Docker Compose for DynamoDB Local |

## Development

Requires Node.js 22+, pnpm and Docker.

```sh
pnpm install
pnpm check        # Biome lint + format check
pnpm typecheck
pnpm test
```

### Running locally

Everything runs on your machine without touching AWS:

```sh
pnpm dev          # DynamoDB Local (Docker), API on :3001, web on http://localhost:5173
pnpm db:down      # stop DynamoDB Local (data is kept in a Docker volume)
pnpm sandbox      # play the engine in the terminal as any seat, judge or admin
```

- `pnpm dev` runs the same Hono app that Lambda runs, as a local Node server with auto-reload,
  against a `ts-local-main` table in DynamoDB Local. The local DynamoDB client always uses the
  local endpoint and dummy credentials, so it can't reach the real account.
- To point the local web client at the live beta API instead:
  `TS_API_URL=https://api.tornsignpost.org pnpm dev:web`.
- The sandbox starts a three-player table with invented test cards. Type `.help` for commands,
  `.as B` to switch seats, `.save file.scenario` to keep the session as a golden scenario.
  Options: `--scenario <file>`, `--catalog <cards.json>`, `--seed <n>`. Console syntax:
  [docs/console.md](docs/console.md).

Deploying (maintainers): `pnpm deploy` builds everything and runs `cdk deploy --all` against the
AWS account in your environment. CI deploys `main` automatically via GitHub OIDC.

## Licence

Code: [AGPL-3.0-only](LICENSE). World of Darkness material is excluded from the licence and from
this repository; see [NOTICE](NOTICE).
