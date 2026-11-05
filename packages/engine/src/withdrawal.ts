/**
 * Withdrawing from the game (GAME-09, docs/m6-plan.md M6.2; rulebook "Withdrawing from the Game";
 * zero-vtes rules-qa Batch 95, 90.9). A Methuselah with an empty library and less than a full hand
 * announces it in their unlock phase; if by their next unlock phase they have lost or spent no pool,
 * no vampire of theirs has lost or spent blood, and none of their minions has entered combat, they
 * leave the game with half a victory point. It isn't an oust: nobody is rewarded.
 */
import type { EventBody } from './events.ts';
import type { GameState } from './model.ts';
import type { SeatId } from './seating.ts';
import { parseZoneId, zoneCards, zoneId } from './zones.ts';

/**
 * A full hand. Cards that change the hand size aren't tracked yet, so for now this is the rulebook
 * hand size; once hand size is enforced, "less than a full hand" uses the seat's (M6 plan, Later).
 */
export const FULL_HAND = 7;

/** What a withdrawal is worth (Tournament Rules; zero-vtes 90.9; M6 plan Q1). */
export const WITHDRAWAL_VP = 0.5;

export type WithdrawalBreak = 'pool' | 'blood' | 'combat';

/** Whether `seat` may announce a withdrawal now (95.3). */
export function canWithdraw(state: GameState, seat: SeatId): boolean {
  const s = state.seats.find((x) => x.id === seat);
  const t = state.turn;
  return (
    state.status === 'active' &&
    !!s &&
    !s.ousted &&
    !s.withdrawn &&
    !s.withdrawing &&
    t?.seat === seat &&
    t.phase === 'unlock' &&
    zoneCards(state, zoneId(seat, 'library')).length === 0 &&
    zoneCards(state, zoneId(seat, 'hand')).length < FULL_HAND
  );
}

/** A vampire of `seat`'s in play: blood counters on a card it controls, ready or in torpor. */
function inPlayBy(state: GameState, card: string, seat: SeatId): boolean {
  const c = state.cards[card];
  if (!c || c.controller !== seat) return false;
  const zone = parseZoneId(c.zone).name;
  return zone === 'ready' || zone === 'torpor';
}

/**
 * The pending withdrawals `body` nullifies, applied to `state` (95.1, 95.2, 95.4): pool lost or
 * spent, blood a vampire of theirs in play loses or spends (an ally's life isn't blood; a minion
 * leaving play takes its blood with it, which is no loss), or a minion of theirs entering combat.
 */
export function withdrawalBreaks(
  state: GameState,
  body: EventBody,
): [seat: SeatId, reason: WithdrawalBreak][] {
  const pending = state.seats.filter((s) => s.withdrawing && !s.ousted && !s.withdrawn);
  if (!pending.length) return [];
  const out: [SeatId, WithdrawalBreak][] = [];
  for (const { id } of pending) {
    switch (body.type) {
      case 'PoolAdjusted':
        if (body.seat === id && body.delta < 0) out.push([id, 'pool']);
        break;
      case 'BloodTransferred':
        if ('pool' in body.from && body.from.pool === id) out.push([id, 'pool']);
        else if ('card' in body.from && inPlayBy(state, body.from.card, id))
          out.push([id, 'blood']);
        break;
      case 'CounterAdjusted':
        if (body.counter === 'blood' && body.delta < 0 && inPlayBy(state, body.card, id)) {
          out.push([id, 'blood']);
        }
        break;
      case 'ActionBlocked': {
        const actor = state.action ? state.cards[state.action.minion]?.controller : undefined;
        const blocker = state.cards[body.blocker]?.controller;
        if (actor === id || blocker === id) out.push([id, 'combat']);
        break;
      }
    }
  }
  return out;
}
