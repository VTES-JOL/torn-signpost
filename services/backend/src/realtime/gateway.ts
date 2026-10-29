import {
  ApiGatewayManagementApiClient,
  GoneException,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';
import type { ServerMessage } from '@torn-signpost/protocol';

/** Sends a message to one live connection; false if the connection is gone. */
export interface ConnectionGateway {
  post(connectionId: string, message: ServerMessage): Promise<boolean>;
}

/** API Gateway WebSocket API connections (architecture §5.4). */
export function awsGateway(callbackUrl: string): ConnectionGateway {
  const client = new ApiGatewayManagementApiClient({ endpoint: callbackUrl });
  return {
    async post(connectionId, message) {
      try {
        await client.send(
          new PostToConnectionCommand({
            ConnectionId: connectionId,
            Data: JSON.stringify(message),
          }),
        );
        return true;
      } catch (e) {
        if (e instanceof GoneException) return false;
        throw e;
      }
    },
  };
}
