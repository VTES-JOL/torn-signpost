/**
 * EventBridge Scheduler target (docs/m5b-plan.md, design decision 5): each one-off schedule
 * invokes this with its payload. Handlers check the current state, so late or repeated firings
 * are harmless; failures are retried by the scheduler and then dead-lettered.
 */
import { z } from 'zod';
import { fireTimer } from '../services.ts';
import type { TimerPayload } from '../timers/timers.ts';
import { servicesFor } from './env.ts';

const GameCommand = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('CheckDeadline'), seat: z.string() }),
  z.strictObject({ type: z.literal('CheckTimeLimit') }),
  z.strictObject({ type: z.literal('EndPause') }),
]);

const Payload = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('presence'), gameId: z.string(), user: z.string() }),
  z.object({ kind: z.literal('game'), gameId: z.string(), command: GameCommand }),
  z.object({ kind: z.literal('email'), user: z.string(), id: z.string() }),
  z.object({ kind: z.literal('digest'), slot: z.enum(['morning', 'evening']) }),
]) satisfies z.ZodType<TimerPayload>;

const services = servicesFor(process.env.WS_CALLBACK_URL ?? '');

export async function handler(event: unknown): Promise<void> {
  const parsed = Payload.safeParse(event);
  if (!parsed.success) {
    // Not retryable: drop it, loudly.
    console.error('unknown timer payload', { event });
    return;
  }
  await fireTimer(services, parsed.data);
}
