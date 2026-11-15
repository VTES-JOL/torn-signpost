/**
 * Runs the API locally (`pnpm dev`): the same Hono app and WebSocket handlers that run in Lambda,
 * against DynamoDB Local, with dev tokens (`Authorization: Bearer dev:alice`).
 */
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { WebSocket, WebSocketServer } from 'ws';
import { createApp } from '../app.ts';
import { archonConfig } from '../archon/config.ts';
import { localSealer } from '../archon/sealer.ts';
import { devAuthenticator } from '../auth.ts';
import { consoleMailer } from '../email/mailer.ts';
import { ApiError } from '../errors.ts';
import type { ConnectionGateway } from '../realtime/gateway.ts';
import { createServices, fireTimer } from '../services.ts';
import { localTimers } from '../timers/timers.ts';
import { local } from './env.ts';

/** Stand-in for API Gateway's connection management API. */
const sockets = new Map<string, WebSocket>();
const gateway: ConnectionGateway = {
  async post(connectionId, message) {
    const socket = sockets.get(connectionId);
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  },
};

const services = createServices({
  tableName: local.tableName,
  endpoint: local.dynamodb.endpoint,
  contentUrl: local.contentUrl,
  gateway,
  timers: (handler) => localTimers(handler),
  presence: true,
  // Emails are printed here, never sent.
  email: {
    mailer: consoleMailer,
    secret: async () => 'local-unsubscribe-secret',
    webUrl: local.webOrigin,
    apiUrl: `http://localhost:${local.port}`,
  },
  // Archon's test server, with the beta's client (its secret read with your AWS credentials), or
  // the fake Archon the end-to-end tests run (ARCHON_URL, ARCHON_CLIENT_ID, ARCHON_CLIENT_SECRET).
  archon: {
    config: archonConfig({
      baseUrl: local.archon.url,
      redirectUri: `${local.webOrigin}/archon/callback`,
      ...(local.archon.client
        ? { client: local.archon.client }
        : { secretId: local.archon.secretId }),
    }),
    // Organisers' grants, sealed under a fixed local key (the beta's use KMS).
    sealer: localSealer(),
  },
});

// Linked tournaments are read from Archon every minute, as the beta's schedule does.
setInterval(
  () => void fireTimer(services, { kind: 'tournaments' }).catch((e) => console.error(e)),
  local.archon.pollMs,
).unref();

const app = createApp({
  stage: 'local',
  version: 'dev',
  allowedOrigins: [local.webOrigin],
  auth: devAuthenticator,
  games: services.games,
  decks: services.decks,
  profiles: services.profiles,
  notifications: services.notifications,
  results: services.results,
  ...(services.email ? { email: services.email } : {}),
  ...(services.archon ? { archon: services.archon } : {}),
  ...(services.tournaments ? { tournaments: services.tournaments } : {}),
});

const server = serve({ fetch: app.fetch, port: local.port }, ({ port }) => {
  console.log(`API listening on http://localhost:${port} (table ${local.tableName})`);
  console.log(`WebSocket on ws://localhost:${port}/ws?token=dev:<user>`);
});

// Mirrors API Gateway: $connect (with ?token=), $default for messages, $disconnect.
const wss = new WebSocketServer({ server: server as Server, path: '/ws' });
wss.on('connection', (socket, req) => {
  const connectionId = randomUUID();
  const token = new URL(req.url ?? '', 'http://localhost').searchParams.get('token') ?? undefined;
  // Like API Gateway, deliver no messages until $connect has finished: listen at once, but queue.
  const connected = (async () => {
    await services.realtime.connect(connectionId, await devAuthenticator(token));
    sockets.set(connectionId, socket);
  })();
  connected.catch((e) => socket.close(1008, e instanceof ApiError ? e.message : 'connect failed'));
  socket.on('message', (data) => {
    connected
      .then(() => services.realtime.message(connectionId, data.toString()))
      .catch((e) => console.error(e));
  });
  socket.on('close', () => {
    sockets.delete(connectionId);
    connected.then(() => services.realtime.disconnect(connectionId)).catch(() => {});
  });
});
