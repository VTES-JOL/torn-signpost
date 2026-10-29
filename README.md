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

## Repository layout

| Path | Contents |
|---|---|
| `packages/engine` | Pure TypeScript rules engine shared by server and clients |
| `packages/protocol` | API and message schemas (Zod) |
| `services/backend` | AWS Lambda handlers |
| `apps/web` | React web client (PWA) |
| `infra` | AWS CDK app |

## Development

Requires Node.js 22+ and pnpm.

```sh
pnpm install
pnpm check        # Biome lint + format check
pnpm typecheck
pnpm test
pnpm dev:web      # web client on http://localhost:5173
```

Deploying (maintainers): `pnpm deploy` builds everything and runs `cdk deploy --all` against the
AWS account in your environment. CI deploys `main` automatically via GitHub OIDC.

## Licence

Code: [AGPL-3.0-only](LICENSE). World of Darkness material is excluded from the licence and from
this repository; see [NOTICE](NOTICE).
