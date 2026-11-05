# Testing

How changes are tested day to day. The levels and tooling are in the architecture (§11, NFR-10).
`pnpm test` runs everything below except the browser tests; CI runs both on every push, and `main`
deploys only when they pass.

## Changing the engine

1. **A scenario for every rules change.** Behaviour goes into a golden scenario
   (`packages/engine/scenarios/*.scenario`, console syntax, [console.md](console.md)) as `expect`
   and `log` lines. A bug fix starts with the scenario line that reproduces it. Scenarios use
   invented cards, so they run everywhere. Scenarios with real cards
   (`scenarios/real-cards/`) only run where a local content pack exists, never in CI (LEGAL-08).
2. **Unit tests** (`decide.test.ts` and others) for rejections, permissions and edge cases that would
   clutter a scenario.
3. **Property tests** (`projection.property.test.ts`, fast-check) play 150 random games per
   property. A new command goes into the random step functions (`guidedStep`, `tableStep`,
   `commandFor`), and a new event that random games should reach goes into the "reach the
   structured flow" list. The games run on a real clock: time passes between commands, and the
   server's timers fire when they fall due. Properties:
   - no projected state or event names a card the viewer can't see; shuffles can't be traced;
   - a client that follows only the events it was sent ends up with the server's view;
   - `evolve` never mutates its input; blood transfers conserve blood;
   - an active game always waits on someone still in it (checked once each command is done);
   - the clock runs exactly when it should, never goes back, and never outruns real time;
   - while paused, only settings, judges and the server act;
   - a timer check only reminds, flags and calls a judge; it never acts for a player (DQ6);
   - a timer that fires early does nothing;
   - no player pauses for more than their allowance in a game;
   - the turn of an active game always belongs to someone still in it;
   - a game ends only for a reason the rules give, and never awards more VP than there are seats;
   - a pending withdrawal never survives pool or blood lost, or combat; a withdrawn Methuselah
     never acts again;
   - judge calls stay consistent: unique, one open per player, deadline calls still overdue.

   Property checks look at the state between events and after commands. Between the events of one
   command the state can be in between (an oust passes the turn in a later event), so rules that
   only hold once a command is done use `forEveryCommand`.

## Coverage

Engine coverage is enforced: `pnpm --filter @torn-signpost/engine test` fails below the floor in
`packages/engine/vitest.config.ts`. The floor only goes up. When a change raises coverage, raise
the thresholds to match (rounded down; CI runs without the real-card scenarios, so measure with
`--exclude src/scenario.real-cards.test.ts`). Don't lower them to get a change through: add the
scenario or test. Random games vary slightly from run to run, so the floor sits a little under
the measured numbers.

## Other levels

- **Backend integration** (`services/backend`): against DynamoDB Local. They're skipped when it
  isn't running (`pnpm db:up`); CI always runs them.
- **Protocol**: the command schemas, with a compile-time check that they match the engine's types.
- **Web**: unit tests for layout, prompts, the clock and the game and replay clients.
- **Infra**: assertions on the synthesized CDK templates.
- **Deploy smoke test**: after each deploy, against the beta.
- **Browser** (`apps/web/e2e`, Playwright): the main table flows in real browsers, one per
  player, against the built web app, the local API and WebSocket server and DynamoDB Local, with
  the invented test cards served by a stand-in content server. Games are set up through the API;
  the part under test is driven through the UI. Covered so far: a bleed with a block decision and
  its resolution, pausing and resuming, and a judge call from the table through the judge queue to
  a ruling, a notification reaching a player elsewhere on the site, and email settings and
  unsubscribe links, game end, withdrawal, and results on players' pages and the leaderboard. Run with `pnpm build` and `pnpm db:up`, then `pnpm --filter @torn-signpost/web
  test:e2e`; it uses its own ports and table, so a running `pnpm dev` is left alone. CI keeps
  traces of failures (`npx playwright show-trace`). Add a test when a change touches one of these
  flows or adds a new one players depend on; layout and styling are still checked by hand.
