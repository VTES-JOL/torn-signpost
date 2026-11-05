# Testing

How changes are tested day to day. The levels and tooling are in the architecture (§11, NFR-10).
`pnpm test` runs everything below; CI runs it on every push, and `main` deploys only when it passes.

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
- **Browser**: no automated tests yet; UI changes are checked by hand in a browser.
