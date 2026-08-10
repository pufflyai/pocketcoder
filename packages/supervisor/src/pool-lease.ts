import {
  HEADER_POOL_ENROLLMENT,
  HEADER_POOL_RUNTIME,
  HEADER_PROTOCOL,
  LeaseAssignmentFrameSchema,
  POOL_PROTOCOL_VERSION,
  type PoolProviderInput,
  type ProviderInput,
} from "@pstdio/pocketcoder-contracts";
import { AGENT_VERSION } from "./supervisor-constants";

export function waitForPoolLease(input: PoolProviderInput): Promise<ProviderInput> {
  return new Promise((resolve, reject) => {
    const base = input.server_url.replace(/^http/, "ws").replace(/\/$/, "");
    const ws = new WebSocket(`${base}/v1/agent/pool-connect`, {
      headers: {
        [HEADER_PROTOCOL]: String(POOL_PROTOCOL_VERSION),
        [HEADER_POOL_RUNTIME]: input.pool_runtime_id,
        [HEADER_POOL_ENROLLMENT]: input.enrollment_secret,
      },
    } as unknown as string[]);
    let assigned = false;
    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          v: POOL_PROTOCOL_VERSION,
          type: "pool_registered",
          pool_runtime_id: input.pool_runtime_id,
          template: {
            name: input.template_name,
            version: input.template_version,
            digest: input.template_digest,
          },
          agent_version: AGENT_VERSION,
        }),
      );
    };
    ws.onmessage = (event) => {
      const parsed = LeaseAssignmentFrameSchema.safeParse(JSON.parse(String(event.data)));
      if (!parsed.success || assigned) return;
      assigned = true;
      ws.close(1000, "lease received");
      resolve(parsed.data.input);
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      if (!assigned) reject(new Error("warm pool enrollment closed before assignment"));
    };
  });
}
