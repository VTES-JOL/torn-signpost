/**
 * Server-Timing for a request: `timed('load', () => …)` records how long a step took, and the app
 * sends the steps back in a `Server-Timing` header (browser dev tools show it under Timing) and
 * logs slow requests. Outside a request, `timed` just runs the step.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

type Steps = { name: string; ms: number }[];
const current = new AsyncLocalStorage<Steps>();

/** Run `fn` with a fresh set of steps; returns its result and the steps recorded. */
export async function withTiming<T>(fn: () => Promise<T>): Promise<{ result: T; steps: Steps }> {
  const steps: Steps = [];
  const result = await current.run(steps, fn);
  return { result, steps };
}

/** Time a step of the current request. */
export async function timed<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
  const steps = current.getStore();
  if (!steps) return fn();
  const start = performance.now();
  try {
    return await fn();
  } finally {
    steps.push({ name, ms: performance.now() - start });
  }
}

/** The Server-Timing header value: `name;dur=12.3, …`. Names are tokens, so `.` becomes `-`. */
export function serverTiming(steps: Steps, totalMs: number): string {
  return [...steps, { name: 'total', ms: totalMs }]
    .map(({ name, ms }) => `${name.replace(/[^\w-]/g, '-')};dur=${ms.toFixed(1)}`)
    .join(', ');
}
