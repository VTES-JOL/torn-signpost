import { randomInt } from 'node:crypto';
import type { Rng } from '@torn-signpost/engine';

/** Cryptographic randomness for shuffles and instance IDs (GAME-15). */
export const cryptoRng: Rng = { int: (maxExclusive) => randomInt(maxExclusive) };
