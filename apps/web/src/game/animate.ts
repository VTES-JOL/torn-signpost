/**
 * Moves on the table animate with a view transition (UX-08): cards keep a `view-transition-name`
 * (`c-<id>`), so the browser slides each one from its old place to its new one.
 */
import { flushSync } from 'react-dom';

export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** A running view transition, as far as callers need it. */
export interface Transition {
  finished: Promise<unknown>;
  skipTransition(): void;
}

/**
 * Apply a change to the table, animated unless motion is reduced or the browser can't. Returns
 * the transition while it runs, so a caller can skip it for the next change.
 */
export function animate(apply: () => void): Transition | undefined {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => Transition };
  if (doc.startViewTransition && !reducedMotion())
    return doc.startViewTransition(() => flushSync(apply));
  apply();
  return undefined;
}
