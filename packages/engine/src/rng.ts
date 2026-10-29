import type { InstanceId } from './model.ts';

/**
 * Randomness is injected so the engine stays pure: the server supplies a cryptographic source
 * (GAME-15), tests a seeded one. Outcomes are recorded in events, so replay never needs the RNG.
 */
export interface Rng {
  /** Uniform integer in [0, maxExclusive). */
  int(maxExclusive: number): number;
}

/** Deterministic mulberry32 generator for tests and scenarios. Not for real games. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return {
    int(maxExclusive) {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * maxExclusive);
    },
  };
}

/** Fisher–Yates shuffle returning a new array. */
export function shuffled<T>(items: readonly T[], rng: Rng): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

const ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/** A fresh random instance ID (60 bits), so re-keyed cards can't be linked to their old ID. */
export function newInstanceId(rng: Rng, taken: (id: InstanceId) => boolean): InstanceId {
  for (;;) {
    let id = '';
    for (let i = 0; i < 12; i++) id += ID_ALPHABET[rng.int(ID_ALPHABET.length)];
    if (!taken(id)) return id;
  }
}
