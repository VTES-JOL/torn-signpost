import { ENGINE_VERSION } from '@torn-signpost/engine';
import {
  type ApiError as ApiErrorBody,
  ChatRequest,
  CommandRequest,
  CreateGameRequest,
  DeckFormat,
  EmailPrefs,
  type HealthResponse,
  JoinGameRequest,
  LobbyStatus,
  MarkReadRequest,
  ResolveEscalationRequest,
  SaveDeckRequest,
  UnsubscribeRequest,
  UpdateProfileRequest,
} from '@torn-signpost/protocol';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';
import { type Authenticator, bearer, GUEST, type Identity } from './auth.ts';
import type { DeckService } from './decks/service.ts';
import type { EmailService } from './email/service.ts';
import { ApiError } from './errors.ts';
import type { GameService } from './games/service.ts';
import type { NotificationService } from './notifications/service.ts';
import type { ResultsService } from './stats/service.ts';
import type { ProfileService } from './users/service.ts';

export interface AppConfig {
  stage: string;
  version: string;
  allowedOrigins: string[];
  auth?: Authenticator;
  /** Missing while the games feature is switched off for the stage. */
  games?: GameService;
  decks?: DeckService;
  profiles?: ProfileService;
  notifications?: NotificationService;
  /** Missing while email is switched off for the stage. */
  email?: EmailService;
  results?: ResultsService;
}

type Env = { Variables: { identity: Identity } };

/** The HTTP API (architecture §5.1). Routes are added per milestone. */
export function createApp(config: AppConfig): Hono<Env> {
  const app = new Hono<Env>();

  app.use('*', cors({ origin: config.allowedOrigins, maxAge: 600 }));

  app.use('*', async (c, next) => {
    const identity = config.auth ? await config.auth(bearer(c.req.header('Authorization'))) : GUEST;
    c.set('identity', config.profiles ? await config.profiles.resolve(identity) : identity);
    await config.email?.seen(identity);
    // Changes count as using the site; reads don't (pages poll in the background).
    if (c.req.method !== 'GET') await config.email?.active(identity);
    await next();
  });

  app.get('/health', (c) => {
    const body: HealthResponse = {
      status: 'ok',
      service: 'torn-signpost-api',
      version: config.version,
      engineVersion: ENGINE_VERSION,
      stage: config.stage,
      time: new Date().toISOString(),
    };
    return c.json(body);
  });

  const games = () => {
    if (!config.games) throw new ApiError(503, 'games_disabled', 'Games are not available yet');
    return config.games;
  };
  const body = async <T extends z.ZodType>(req: { json(): Promise<unknown> }, schema: T) => {
    let json: unknown;
    try {
      json = await req.json();
    } catch {
      throw new ApiError(400, 'invalid_json', 'Request body must be JSON');
    }
    return schema.parse(json) as z.infer<T>;
  };

  // Guests can watch public games (GAME-16) but every change needs a signed-in player.
  app.on(['POST', 'PUT', 'DELETE'], '/games/*', async (c, next) => {
    if (c.var.identity.kind !== 'user') throw new ApiError(401, 'sign_in', 'Sign in first');
    await next();
  });
  app.post('/games', async (c, next) => {
    if (c.var.identity.kind !== 'user') throw new ApiError(401, 'sign_in', 'Sign in first');
    await next();
  });

  app.get('/games', async (c) => {
    const filter = z.union([LobbyStatus, z.literal('mine')]).parse(c.req.query('status') ?? 'open');
    return c.json(await games().list(c.var.identity, filter));
  });
  app.post('/games', async (c) =>
    c.json(await games().create(c.var.identity, await body(c.req, CreateGameRequest)), 201),
  );
  app.get('/games/:id', async (c) =>
    c.json(await games().details(c.var.identity, c.req.param('id'))),
  );
  // A finished game's result: public for counted games, even private ones (M6.6, F2).
  app.get('/games/:id/result', async (c) =>
    c.json(await games().result(c.var.identity, c.req.param('id'))),
  );
  app.post('/games/:id/join', async (c) =>
    c.json(
      await games().join(c.var.identity, c.req.param('id'), await body(c.req, JoinGameRequest)),
    ),
  );
  app.post('/games/:id/start', async (c) =>
    c.json(await games().start(c.var.identity, c.req.param('id'))),
  );
  app.post('/games/:id/commands', async (c) =>
    c.json(
      await games().command(c.var.identity, c.req.param('id'), await body(c.req, CommandRequest)),
    ),
  );
  app.post('/games/:id/leave', async (c) =>
    c.json(await games().leave(c.var.identity, c.req.param('id'))),
  );
  app.post('/games/:id/chat', async (c) =>
    c.json(
      await games().chat(c.var.identity, c.req.param('id'), await body(c.req, ChatRequest)),
      201,
    ),
  );
  app.get('/games/:id/chat', async (c) =>
    c.json(await games().chatHistory(c.var.identity, c.req.param('id'))),
  );
  // The judge queue (GAME-18): open calls across every game, for judges.
  app.get('/judge/calls', async (c) => c.json(await games().judgeQueue(c.var.identity)));
  // The admin queue (GAME-19): casual games judges referred to the admins.
  app.get('/admin/escalations', async (c) => c.json(await games().escalations(c.var.identity)));
  app.post('/admin/escalations/:gameId/:callId', async (c) => {
    if (c.var.identity.kind !== 'user') throw new ApiError(401, 'sign_in', 'Sign in first');
    await games().resolveEscalation(
      c.var.identity,
      c.req.param('gameId'),
      c.req.param('callId'),
      await body(c.req, ResolveEscalationRequest),
      (name) => profiles().userByName(name),
    );
    return c.body(null, 204);
  });
  app.get('/games/:id/events', async (c) => {
    const after = z.coerce
      .number()
      .int()
      .min(0)
      .parse(c.req.query('after') ?? '0');
    return c.json(await games().events(c.var.identity, c.req.param('id'), after));
  });

  // Decks (DECK-03/07). Public decks are readable by guests.
  const decks = () => {
    if (!config.decks) throw new ApiError(503, 'decks_disabled', 'Decks are not available yet');
    return config.decks;
  };
  app.on(['POST', 'PUT', 'DELETE'], '/decks/*', async (c, next) => {
    if (c.var.identity.kind !== 'user') throw new ApiError(401, 'sign_in', 'Sign in first');
    await next();
  });
  app.get('/decks', async (c) => c.json(await decks().mine(c.var.identity)));
  app.get('/decks/public', async (c) =>
    c.json(await decks().listPublic(DeckFormat.parse(c.req.query('format') ?? 'standard'))),
  );
  app.post('/decks', async (c) => {
    if (c.var.identity.kind !== 'user') throw new ApiError(401, 'sign_in', 'Sign in first');
    return c.json(await decks().create(c.var.identity, await body(c.req, SaveDeckRequest)), 201);
  });
  app.get('/decks/:id', async (c) => c.json(await decks().get(c.var.identity, c.req.param('id'))));
  app.put('/decks/:id', async (c) =>
    c.json(
      await decks().update(c.var.identity, c.req.param('id'), await body(c.req, SaveDeckRequest)),
    ),
  );
  app.delete('/decks/:id', async (c) => {
    await decks().delete(c.var.identity, c.req.param('id'));
    return c.body(null, 204);
  });
  app.get('/decks/:id/versions/:version', async (c) => {
    const version = z.coerce.number().int().min(1).parse(c.req.param('version'));
    return c.json(await decks().version(c.var.identity, c.req.param('id'), version));
  });

  // Profiles (AUTH-05).
  const profiles = () => {
    if (!config.profiles)
      throw new ApiError(503, 'profiles_disabled', 'Profiles are not available');
    return config.profiles;
  };
  app.get('/me', async (c) => c.json(await profiles().me(c.var.identity)));
  app.put('/me', async (c) => {
    if (c.var.identity.kind !== 'user') throw new ApiError(401, 'sign_in', 'Sign in first');
    return c.json(await profiles().choose(c.var.identity, await body(c.req, UpdateProfileRequest)));
  });

  // Notifications (NOTIF-01): your own, newest first.
  const notifications = () => {
    if (!config.notifications)
      throw new ApiError(503, 'notifications_disabled', 'Notifications are not available');
    return config.notifications;
  };
  app.get('/me/notifications', async (c) => {
    const before = z.string().min(1).max(64).optional().parse(c.req.query('before'));
    return c.json(await notifications().list(c.var.identity, before));
  });
  app.post('/me/notifications/read', async (c) =>
    c.json(await notifications().markRead(c.var.identity, await body(c.req, MarkReadRequest))),
  );

  // Email notifications (NOTIF-02): your settings, and unsubscribing from a link in an email.
  const email = () => {
    if (!config.email) throw new ApiError(503, 'email_disabled', 'Email is not available yet');
    return config.email;
  };
  app.get('/me/email', async (c) => c.json(await email().settings(c.var.identity)));
  app.put('/me/email', async (c) =>
    c.json(await email().savePrefs(c.var.identity, await body(c.req, EmailPrefs))),
  );
  // One-click (RFC 8058) mail clients POST here with the link's query; so does the web page.
  app.post('/email/unsubscribe', async (c) => {
    await email().unsubscribe(UnsubscribeRequest.parse(c.req.query()));
    return c.body(null, 204);
  });
  // Results and stats (STATS-01..03): public, for counted games.
  const results = () => {
    if (!config.results) throw new ApiError(503, 'stats_disabled', 'Stats are not available yet');
    return config.results;
  };
  app.get('/users/:key', async (c) => c.json(await results().profile(c.req.param('key'))));
  app.get('/users/:key/games', async (c) => {
    const before = z.string().min(1).max(64).optional().parse(c.req.query('before'));
    return c.json(await results().history(c.req.param('key'), before));
  });
  app.get('/leaderboards', async (c) => {
    const q = z
      .object({
        season: z
          .string()
          .regex(/^\d{4}$/)
          .optional(),
        format: z.enum(['standard', 'v5', 'duel']).optional(),
        by: z.enum(['gw', 'vp', 'winrate']).optional(),
      })
      .parse(c.req.query());
    return c.json(
      await results().leaderboard({
        ...(q.season ? { season: q.season } : {}),
        ...(q.format ? { format: q.format } : {}),
        ...(q.by ? { by: q.by } : {}),
      }),
    );
  });
  app.put('/users/:name/name', async (c) => {
    if (c.var.identity.kind !== 'user') throw new ApiError(401, 'sign_in', 'Sign in first');
    const req = await body(c.req, UpdateProfileRequest);
    await profiles().adminRename(c.var.identity, c.req.param('name'), req);
    return c.body(null, 204);
  });

  app.notFound((c) =>
    c.json({ error: 'not_found', message: 'Not found' } satisfies ApiErrorBody, 404),
  );

  app.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json({ error: err.code, message: err.message } satisfies ApiErrorBody, err.status);
    }
    if (err instanceof z.ZodError) {
      const message = err.issues
        .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
        .join('; ');
      return c.json({ error: 'invalid_request', message } satisfies ApiErrorBody, 400);
    }
    console.error('unhandled error', err);
    return c.json(
      { error: 'internal', message: 'Something went wrong' } satisfies ApiErrorBody,
      500,
    );
  });

  return app;
}
