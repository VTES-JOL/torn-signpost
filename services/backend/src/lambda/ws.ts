/** API Gateway WebSocket API handler: $connect, $disconnect and $default (architecture §5.4). */
import type { APIGatewayProxyResult, APIGatewayProxyWebsocketEventV2 } from 'aws-lambda';
import { ApiError } from '../errors.ts';
import { auth, gamesEnabled, servicesFor } from './env.ts';

type ConnectEvent = APIGatewayProxyWebsocketEventV2 & {
  queryStringParameters?: Record<string, string | undefined>;
};

export async function handler(event: ConnectEvent): Promise<APIGatewayProxyResult> {
  const { routeKey, connectionId, apiId, stage } = event.requestContext;
  // Built from the request, since the API can't be passed to its own Lambda as configuration.
  const services = servicesFor(
    `https://${apiId}.execute-api.${process.env.AWS_REGION}.amazonaws.com/${stage}`,
  );
  try {
    switch (routeKey) {
      case '$connect': {
        if (!gamesEnabled) return { statusCode: 503, body: 'Games are not available yet' };
        // Browsers can't set headers on WebSockets, so the ID token comes in the query string.
        const identity = await auth(event.queryStringParameters?.token);
        await services.realtime.connect(connectionId, identity);
        return { statusCode: 200, body: '' };
      }
      case '$disconnect':
        await services.realtime.disconnect(connectionId);
        return { statusCode: 200, body: '' };
      default:
        await services.realtime.message(connectionId, event.body ?? '');
        return { statusCode: 200, body: '' };
    }
  } catch (e) {
    if (e instanceof ApiError) return { statusCode: e.status, body: e.message };
    console.error('ws error', { routeKey, error: e });
    return { statusCode: 500, body: '' };
  }
}
