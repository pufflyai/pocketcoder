import { randomBytes } from "node:crypto";
import type { PocketCoderClient } from "@pstdio/pocketcoder-sdk";
import {
  createOpenAIGatewayHandler,
  type OpenAIGatewayConfig,
} from "../harnesses/pi/openai-gateway";

export function workspaceGateway(
  client: PocketCoderClient,
  config: Omit<OpenAIGatewayConfig, "clientBearer"> & { allowedModel: string },
) {
  const bearer = randomBytes(32).toString("base64url");
  let workspaceId: string | undefined;
  const forward = createOpenAIGatewayHandler({ ...config, clientBearer: bearer });
  const server = Bun.serve({
    hostname: "0.0.0.0",
    port: 0,
    async fetch(request) {
      if (!workspaceId) return new Response("workspace not assigned", { status: 503 });
      const workspace = await client.workspaces.get(workspaceId);
      if (!["provisioning", "connected", "ready", "preserving"].includes(workspace.state)) {
        return new Response("workspace gateway revoked", { status: 410 });
      }
      return forward(request);
    },
  });
  return {
    bearer,
    url: `http://host.docker.internal:${server.port}/v1`,
    localUrl: `http://127.0.0.1:${server.port}`,
    bind(id: string) {
      workspaceId = id;
    },
    close() {
      server.stop(true);
    },
  };
}
