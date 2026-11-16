/**
 * Which of zero-vtes's rulings (`docs/rules-qa.md`) the engine is answerable for. The engine plays
 * the game's own rules (turns, the action flow and its windows, combat, politics, ousting,
 * withdrawal, torpor, rescue, diablerie, blood hunts) and leaves card effects, and the stealth and
 * intercept count, to the players (docs/flow.md, "Overrides"; GAME-14). So most of rules-qa, which
 * is card by card, is out of scope; these batches are the rules, and within them `OUT` sets aside
 * the rulings that are a card's own reading.
 *
 * Any ruling our code or tests cite is in scope whatever its batch: citing it says it applies.
 * Triaged 2026-11-16 against zero-vtes cb74d11.
 */

/** Batches about the game's rules rather than particular cards. */
export const RULES_BATCHES: Record<number, string> = {
  1: 'Sequencing, impulse, windows',
  2: 'Window arbitration',
  3: 'Open items: contests, costs, impulse',
  4: 'Combat',
  5: 'Politics',
  45: 'The decision point before an oust',
  46: 'Found in play: limits per action, votes',
  47: 'Additional strikes',
  48: 'Found in play: blocks, strikes, rescue',
  61: 'End of round',
  66: 'The as-announced window',
  81: 'Diablerie of an older vampire',
  82: 'A block attempt short of the stealth',
  86: 'The master Discipline search',
  88: 'Open contradictions that change play',
  90: 'Open contradictions, the rest',
  91: 'The two-player variant',
  92: 'A block attempt failed by a bar on blockers',
  95: 'Tournament withdrawal',
  98: 'Combat polled past the combatants',
  100: 'Reachable edges: contests',
  101: 'Reachable edges: mid-play ousts and costs',
  110: 'The as-played window',
  114: 'Changing blocker during an attempt',
  117: 'What a fizzle pays',
  118: 'An oust as the pool reaches 0',
  119: 'A card put in play is played',
};

const CARD = 'a card’s own reading: players carry out card effects';
const STEALTH = 'stealth and intercept are counted by players';

/** Rulings in those batches the engine isn't answerable for, and why. */
export const OUT: Record<string, string> = {
  '1.6': 'settled by 3.2',
  '2.3': 'zero-vtes’s own vocabulary',
  '3.2': STEALTH,
  '3.4': CARD,
  '3.5': CARD,
  '4.1': CARD,
  '4.4': 'struck out in rules-qa',
  '5.5': CARD,
  '5.6': CARD,
  '5.7': CARD,
  '45.2': CARD,
  '45.3': CARD,
  '45.4': CARD,
  '45.5': CARD,
  '45.6': CARD,
  '45.7': CARD,
  '45.8': 'the deficit is Life Boon’s (a card) to make good; the oust applies as the command ends',
  '46.3': CARD,
  '46.4': CARD,
  '47.1': CARD,
  '48.1': STEALTH,
  '48.4': CARD,
  '48.7': CARD,
  '61.2': CARD,
  '66.2': STEALTH,
  '88.1': CARD,
  '88.5': CARD,
  '88.6': CARD,
  '88.7': STEALTH,
  '88.8': CARD,
  '88.9': CARD,
  '88.10': CARD,
  '88.11': CARD,
  '90.1': CARD,
  '90.4': CARD,
  '90.6': CARD,
  '90.7': CARD,
  '90.10': CARD,
  '92.2': CARD,
  '92.3': CARD,
  '100.2': 'superseded by 3.1',
  '100.3': CARD,
  '100.4': 'superseded by 3.1',
  '101.1': CARD,
  '117.2': 'costs printed on cards, which players pay (the engine’s own, rescue’s, is 117.5)',
  '117.4': CARD,
  '117.6': 'political action cards’ costs and terms, which players pay and choose',
  '118.4': 'zero-vtes’s engine’s own limit',
  '119.1': CARD,
  '119.2': CARD,
  '119.3': CARD,
};
