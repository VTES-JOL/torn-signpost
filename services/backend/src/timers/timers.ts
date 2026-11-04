/**
 * One-off timers (docs/m5b-plan.md, design decision 5): EventBridge Scheduler one-time schedules in
 * AWS, in-process timeouts locally. A firing is handled by `fireTimer`, which turns it into work
 * that checks the current state, so a stale or duplicate firing does nothing.
 */
import { createHash } from 'node:crypto';
import {
  ConflictException,
  CreateScheduleCommand,
  DeleteScheduleCommand,
  ResourceNotFoundException,
  SchedulerClient,
  UpdateScheduleCommand,
} from '@aws-sdk/client-scheduler';

/** What a timer does when it fires. */
export type TimerPayload =
  /** A seated player's last connection to the game closed: mark them away if still gone. */
  { kind: 'presence'; gameId: string; user: string };

export interface Timers {
  /** Fire `payload` at `at`; scheduling the same key again moves it. */
  schedule(key: string, at: Date, payload: TimerPayload): Promise<void>;
  cancel(key: string): Promise<void>;
}

export type TimerHandler = (payload: TimerPayload) => Promise<void>;

/** In-process timers for the local server and tests. Lost on restart, which is fine locally. */
export function localTimers(
  fire: () => TimerHandler,
  now: () => number = Date.now,
): Timers & { pending(): number } {
  const handles = new Map<string, ReturnType<typeof setTimeout>>();
  return {
    async schedule(key, at, payload) {
      clearTimeout(handles.get(key));
      const handle = setTimeout(
        () => {
          handles.delete(key);
          fire()(payload).catch((e) => console.error('timer failed', { key, error: e }));
        },
        Math.max(0, at.getTime() - now()),
      );
      handles.set(key, handle);
    },
    async cancel(key) {
      clearTimeout(handles.get(key));
      handles.delete(key);
    },
    pending: () => handles.size,
  };
}

export interface SchedulerConfig {
  group: string;
  targetArn: string;
  roleArn: string;
  deadLetterArn?: string;
}

/**
 * EventBridge Scheduler one-time schedules, deleted after they run. Delivery is usually within a
 * minute of the requested time, which is fine for every timer here.
 */
export function schedulerTimers(config: SchedulerConfig, client = new SchedulerClient()): Timers {
  return {
    async schedule(key, at, payload) {
      const input = {
        Name: scheduleName(key),
        GroupName: config.group,
        ScheduleExpression: `at(${at.toISOString().slice(0, 19)})`,
        ScheduleExpressionTimezone: 'UTC',
        FlexibleTimeWindow: { Mode: 'OFF' as const },
        ActionAfterCompletion: 'DELETE' as const,
        Target: {
          Arn: config.targetArn,
          RoleArn: config.roleArn,
          Input: JSON.stringify(payload),
          RetryPolicy: { MaximumRetryAttempts: 2, MaximumEventAgeInSeconds: 3600 },
          ...(config.deadLetterArn ? { DeadLetterConfig: { Arn: config.deadLetterArn } } : {}),
        },
      };
      try {
        await client.send(new CreateScheduleCommand(input));
      } catch (e) {
        if (!(e instanceof ConflictException)) throw e;
        await client.send(new UpdateScheduleCommand(input));
      }
    },
    async cancel(key) {
      try {
        await client.send(
          new DeleteScheduleCommand({ Name: scheduleName(key), GroupName: config.group }),
        );
      } catch (e) {
        if (!(e instanceof ResourceNotFoundException)) throw e;
      }
    },
  };
}

/** Schedule names allow 64 characters of [0-9a-zA-Z-_.]; keys hold user IDs, so hash them. */
export function scheduleName(key: string): string {
  const [kind = 'timer'] = key.split(':');
  return `${kind}-${createHash('sha256').update(key).digest('hex').slice(0, 40)}`;
}

export const presenceKey = (gameId: string, user: string) => `presence:${gameId}:${user}`;
