/**
 * Moves on the table animate with a view transition (UX-08): cards keep a `view-transition-name`
 * (`c-<id>`), so the browser slides each one from its old place to its new one.
 */
import { flushSync } from 'react-dom';

export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Apply a change to the table, animated unless motion is reduced or the browser can't. */
export function animate(apply: () => void): void {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  if (doc.startViewTransition && !reducedMotion()) doc.startViewTransition(() => flushSync(apply));
  else apply();
}
