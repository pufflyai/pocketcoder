// Joins exact WebSocket closure, queued frames and disconnect work under controller ownership.

import type { RuntimeOperations as ControllerOperations } from "@pstdio/pocketcoder-runtime-core";
import type { WSEvents } from "hono/ws";

export function ownWebSocket<C>(factory: (context: C) => WSEvents, operations: ControllerOperations) {
  return (context: C): WSEvents => {
    const events = factory(context);
    let connection: ReturnType<ControllerOperations["connection"]> | undefined;
    let frames: Promise<void> = Promise.resolve();
    return {
      onOpen: (event, ws) => {
        try {
          connection = operations.connection();
          frames = connection.dispatch(async () => {
            await events.onOpen?.(event, ws);
          });
          void frames.catch(() => ws.close(1011, "controller work failed"));
        } catch {
          ws.close(1001, "controller admission closed");
        }
      },
      onMessage: (event, ws) => {
        if (!connection) return ws.close(1001, "controller admission closed");
        const earlier = frames;
        frames = connection
          .dispatch(async () => {
            await earlier;
            await events.onMessage?.(event, ws);
          })
          .catch(async (error) => {
            await earlier.catch(() => {});
            throw error;
          });
        void frames.catch(() => ws.close(1001, "controller admission closed"));
      },
      onClose: (event, ws) => {
        if (!connection) return;
        void connection
          .finish(async () => {
            // Disconnect still runs if an earlier admitted frame failed.
            await frames.catch(() => {});
            await events.onClose?.(event, ws);
          })
          .catch(() => {});
      },
      onError: (event, ws) => {
        if (connection) {
          void connection
            .dispatch(async () => {
              await events.onError?.(event, ws);
              throw new Error("controller_transport_failed");
            })
            .catch(() => {});
        }
        ws.close(1011, "transport failed");
      },
    };
  };
}
