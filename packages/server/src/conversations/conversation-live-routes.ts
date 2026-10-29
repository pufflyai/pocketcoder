import type { OpenAPIHono } from "@hono/zod-openapi";
import type { ConversationLiveEvent } from "@pstdio/pocketcoder-contracts";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { type AppEnv, requireScope } from "../http/middleware";
import type { WorkspaceService } from "../workspaces/service";
import type { LiveTurns } from "./live-turns";

const KEEPALIVE_MS = 15_000;

// The open turn exists only in memory. A reader takes stored history from the cursor routes
// and the turn in progress from here; `committed` tells it to page the stored record.
export function registerConversationLiveRoutes({
  app,
  service,
  liveTurns,
}: {
  app: OpenAPIHono<AppEnv>;
  service: WorkspaceService;
  liveTurns: LiveTurns;
}) {
  async function stream(c: Context<AppEnv>, match: (event: ConversationLiveEvent) => boolean) {
    const workspace = await service.getOwned(c.get("principal"), c.req.param("id") as string);
    return streamSSE(c, async (sse) => {
      const send = (event: ConversationLiveEvent) =>
        void sse.writeSSE({ event: event.type, data: JSON.stringify(event) }).catch(() => {});
      const unsubscribe = liveTurns.subscribe(workspace.id, (event) => {
        if (match(event)) send(event);
      });
      for (const turn of liveTurns.open(workspace.id)) if (match(turn)) send(turn);
      const closed = new Promise<void>((resolve) => sse.onAbort(resolve));
      while (!sse.aborted && !sse.closed) {
        await Promise.race([closed, sse.sleep(KEEPALIVE_MS)]);
        if (!sse.aborted && !sse.closed) await sse.writeSSE({ event: "keepalive", data: "{}" });
      }
      unsubscribe();
    });
  }

  app.get("/v1/workspaces/:id/conversation/live", requireScope("conversations:read"), (c) => stream(c, () => true));
  app.get("/v1/workspaces/:id/conversations/:conversation_id/live", requireScope("conversations:read"), (c) =>
    stream(c, (event) => event.conversation_id === c.req.param("conversation_id")),
  );
}
