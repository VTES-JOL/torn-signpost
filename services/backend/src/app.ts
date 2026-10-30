import { ENGINE_VERSION } from '@torn-signpost/engine';
import {
  type ApiError as ApiErrorBody,
  ChatRequest,
  CommandRequest,
  CreateGameRequest,
  DeckFormat,
  type HealthResponse,
  JoinGameRequest,
  LobbyStatus,
  SaveDeckRequest,
  UpdateProfileRequest,
} from '@torn-signpost/protocol';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';
import { type Authenticator, bearer, GUEST, type Identity } from './auth.ts';
import type { DeckService } from './decks/service.ts';
import { ApiError } from './errors.ts';
import type { GameService } from './games/service.ts';
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
}

type Env = { Variables: { identity: Identity } };

/** The HTTP API (architecture §5.1). Routes are added per milestone. */
export function createApp(config: AppConfig): Hono<Env> {
  const app = new Hono<Env>();

  app.use('*', cors({ origin: config.allowedOrigins, maxAge: 600 }));

  app.use('*', async (c, next) => {
    const identity = config.auth ? await config.auth(bearer(c.req.header('Authorization'))) : GUEST;
    c.set('identity', config.profiles ? await config.profiles.resolve(identity) : identity);
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
