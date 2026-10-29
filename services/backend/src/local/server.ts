/**
 * Runs the API locally (`pnpm dev`): the same Hono app and WebSocket handlers that run in Lambda,
 * against DynamoDB Local, with dev tokens (`Authorization: Bearer dev:alice`).
 */
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { WebSocket, WebSocketServer } from 'ws';
import { createApp } from '../app.ts';
import { devAuthenticator } from '../auth.ts';
import { ApiError } from '../errors.ts';
import type { ConnectionGateway } from '../realtime/gateway.ts';
import { createServices } from '../services.ts';
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
});

const app = createApp({
  stage: 'local',
  version: 'dev',
  allowedOrigins: [local.webOrigin],
  auth: devAuthenticator,
  games: services.games,
  decks: services.decks,
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
