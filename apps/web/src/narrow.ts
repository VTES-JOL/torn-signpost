/**
 * The phone layout's breakpoint, shared with styles.css (`max-width: 760px`): below it the game
 * fits the screen, opponents fold to one line each, and the log and card menu become sheets.
 */
import { useSyncExternalStore } from 'react';

export const NARROW = '(max-width: 760px)';

const query = () => (typeof window === 'undefined' ? undefined : window.matchMedia?.(NARROW));

const subscribe = (onChange: () => void) => {
  const q = query();
  q?.addEventListener('change', onChange);
  return () => q?.removeEventListener('change', onChange);
};

/** True on a phone-sized screen. */
export function useNarrow(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => query()?.matches ?? false,
    () => false,
  );
}
