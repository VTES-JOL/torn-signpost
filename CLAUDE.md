# Notes for Claude

## Tests for rules

When writing tests or scenarios for game rules, find real-world examples first and build the
tests from them:

- the VEKN rulebook's worked examples (vekn.net/rulebook, e.g. the Nassir, Tamoszius and Ryan
  aggravated-damage examples, or the five-player ousting game);
- published rulings: zero-vtes `docs/rules-qa.md` (preferred when sources conflict), VEKN card
  rulings, and judge answers on the VEKN rules forum.

Cite the source in the scenario's comments, use the example's numbers, and expect what the source
says, not what the engine does. A test that fails against a ruling is a finding: fix the engine,
or report the difference if it's a design decision. Scenarios 19–21 in
`packages/engine/scenarios/` show the pattern. See `docs/testing.md` for the rest of the testing
rules.
