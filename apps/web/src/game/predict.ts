/**
 * Predicting a command's events in the browser, so the table moves the moment a player acts
 * instead of a round trip later. The engine that decides on the server runs here against the
 * player's view; the server's answer replaces the prediction when it arrives.
 *
 * A prediction is only made when the view holds everything the command needs:
 *
 * - no randomness (a shuffle, a new card's ID): the server's dice would differ;
 * - no card the viewer would see whose identity the view doesn't hold (a draw from the library):
 *   only the server knows what it is.
 *
 * Anything else the view lacks makes the engine refuse or throw, and the command simply waits for
 * the server. A refusal here is never shown: the server decides.
 */
import {
  type Actor,
  type CardCatalog,
  canSee,
  decide,
  evolve,
  type GameEvent,
  type GameState,
  type Viewer,
} from '@torn-signpost/engine';
import type { PlayerCommand } from '@torn-signpost/protocol';
import type { User } from '../auth.tsx';

class NeedsServer extends Error {}

const NO_DICE = {
  int(): number {
    throw new NeedsServer('randomness');
  },
};

export interface PredictContext {
  user: User;
  viewer: Viewer;
  catalog: CardCatalog;
  now: Date;
}

/** The events `command` would add to `view`, or undefined when only the server can say. */
export function predict(
  view: GameState,
  command: PlayerCommand,
  ctx: PredictContext,
): GameEvent[] | undefined {
  const actor = actorFor(ctx.user, view, command.type);
  if (!actor) return undefined;
  try {
    const result = decide(view, command, {
      actor,
      now: ctx.now.toISOString(),
      rng: NO_DICE,
      catalog: ctx.catalog,
    });
    if (!result.ok) return undefined;
    let after = view;
    for (const ev of result.events) after = evolve(after, ev);
    for (const card of Object.values(after.cards)) {
      if (card.cardId === undefined && canSee(card, ctx.viewer)) return undefined;
    }
    return result.events;
  } catch {
    return undefined;
  }
}

/** Who the server will take the command to be from (the backend's actorFor, without the errors). */
function actorFor(user: User, view: GameState, type: PlayerCommand['type']): Actor | undefined {
  if (type === 'ReplacePlayer' || type === 'EndGame') {
    return user.groups.includes('admin') ? { kind: 'admin', user: user.sub } : undefined;
  }
  if (view.seats.some((s) => s.occupant === user.sub)) return { kind: 'player', user: user.sub };
  if (user.groups.includes('judge')) return { kind: 'judge', user: user.sub };
  return undefined;
}
