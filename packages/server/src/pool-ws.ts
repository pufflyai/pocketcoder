import { verifyOpaque } from "@pstdio/pocketcoder-auth";
import {
  errorEnvelope,
  HEADER_POOL_ENROLLMENT,
  HEADER_POOL_RUNTIME,
  HEADER_PROTOCOL,
  LeaseAssignmentFrameSchema,
  POOL_PROTOCOL_VERSION,
  PoolRegisteredFrameSchema,
  type ProviderInput,
} from "@pstdio/pocketcoder-contracts";
import type { Store, WarmPoolConnections, WarmPoolManager } from "@pstdio/pocketcoder-runtime-core";
import type { MiddlewareHandler } from "hono";
import type { WSContext, WSEvents } from "hono/ws";
import type { AppEnv } from "./middleware";

export class PoolConnectionHub implements WarmPoolConnections {
  private readonly connections = new Map<string, WSContext>();

  attach(runtimeId: string, ws: WSContext): void {
    this.connections.get(runtimeId)?.close(1008, "superseded pool connection");
    this.connections.set(runtimeId, ws);
  }

  detach(runtimeId: string, ws: WSContext): void {
    if (this.connections.get(runtimeId) === ws) this.connections.delete(runtimeId);
  }

  assign(runtimeId: string, input: ProviderInput): boolean {
    const ws = this.connections.get(runtimeId);
    if (!ws) return false;
    const frame = LeaseAssignmentFrameSchema.parse({
      v: POOL_PROTOCOL_VERSION,
      type: "lease_assignment",
      input,
    });
    try {
      ws.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }

  isConnected(runtimeId: string): boolean {
    return this.connections.has(runtimeId);
  }
  close(runtimeId: string): void {
    const ws = this.connections.get(runtimeId);
    this.connections.delete(runtimeId);
    ws?.close(1000, "pool runtime drained");
  }
}

interface PoolAuth {
  runtimeId: string;
}

export function poolConnectValidator(deps: {
  store: Store;
  pepper: string;
}): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const reject = (message: string) =>
      c.json(errorEnvelope("auth.invalid_key", message, c.get("requestId") ?? ""), 401);
    if (Number(c.req.header(HEADER_PROTOCOL)) !== POOL_PROTOCOL_VERSION)
      return reject("Unsupported pool protocol version.");
    const runtimeId = c.req.header(HEADER_POOL_RUNTIME) ?? "";
    const secret = c.req.header(HEADER_POOL_ENROLLMENT) ?? "";
    const row = runtimeId ? await deps.store.getWarmPoolRuntime(runtimeId) : null;
    if (
      row?.state !== "provisioning" ||
      !row.enrollmentDigest ||
      !row.enrollmentExpiresAt ||
      row.enrollmentExpiresAt <= new Date() ||
      !verifyOpaque(deps.pepper, secret, row.enrollmentDigest)
    ) {
      return reject("Invalid or expired pool enrollment credential.");
    }
    c.set("poolAuth" as never, { runtimeId } as never);
    await next();
  };
}

export function poolWsEvents(deps: {
  store: Store;
  hub: PoolConnectionHub;
  manager: WarmPoolManager;
  log?: (message: string) => void;
}) {
  return (c: { get: (key: string) => unknown }): WSEvents => {
    const auth = c.get("poolAuth") as PoolAuth;
    let registered = false;
    return {
      onMessage: (event, ws) => {
        void (async () => {
          if (registered) {
            ws.close(1008, "pool runtime already registered");
            return;
          }
          const raw =
            typeof event.data === "string"
              ? event.data
              : Buffer.from(event.data as ArrayBuffer).toString("utf8");
          const parsed = PoolRegisteredFrameSchema.safeParse(JSON.parse(raw));
          const row = await deps.store.getWarmPoolRuntime(auth.runtimeId);
          if (
            !parsed.success ||
            !row ||
            parsed.data.pool_runtime_id !== row.id ||
            parsed.data.template.digest !== row.templateDigest ||
            parsed.data.template.name !== row.templateName ||
            parsed.data.template.version !== row.templateVersion
          ) {
            ws.close(1008, "invalid pool registration");
            return;
          }
          deps.hub.attach(row.id, ws);
          registered = await deps.manager.markReady(row.id);
          if (!registered) ws.close(1008, "pool registration no longer valid");
        })().catch((error) => {
          deps.log?.(`pool ws ${auth.runtimeId}: ${String(error)}`);
          ws.close(1011, "pool registration failed");
        });
      },
      onClose: (_event, ws) => {
        deps.hub.detach(auth.runtimeId, ws);
        void deps.manager.disconnected(auth.runtimeId);
      },
    };
  };
}
