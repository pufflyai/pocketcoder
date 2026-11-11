import { expect, test } from "bun:test";
import { digestOf } from "@pstdio/pocketcoder-contracts";
import { startLeaseGateway } from "./lease-gateway";

test("gateway credentials are bound to one live workspace lease and revocation survives a late mint", async () => {
  const upstream = Bun.serve({
    port: 0,
    fetch: (req) => Response.json({ authorization: req.headers.get("authorization") }),
  });
  const gateway = await startLeaseGateway({ upstreamUrl: upstream.url.toString(), upstreamBearer: "host-only" });
  const identity = {
    workspace_id: crypto.randomUUID(),
    source_url: null,
    source_revision: null,
    template_digest: digestOf("template"),
    request_id: crypto.randomUUID(),
    request_digest: digestOf("request"),
    policy_digest: digestOf(gateway.config.policy),
    purpose: "runtime-issuer",
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    policy: gateway.config.policy,
  };
  const issue = async (operation: string, input = identity) => {
    const reply = await fetch(gateway.config.url, {
      method: "POST",
      headers: { authorization: gateway.config.authorization, "content-type": "application/json" },
      body: JSON.stringify({ ...input, operation }),
      tls: { ca: gateway.ca },
    });
    return reply;
  };
  try {
    const minted = (await (await issue("mint")).json()) as { workspace_id: string; credential: string };
    expect(minted.workspace_id).toBe(identity.workspace_id);
    expect(minted.credential).not.toBe("host-only");
    const call = () =>
      fetch(gateway.url + "/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${minted.credential}` },
        body: "{}",
      });
    expect(await (await call()).json()).toEqual({ authorization: "Bearer host-only" });
    expect((await issue("mint", { ...identity, workspace_id: crypto.randomUUID() })).status).toBe(409);
    await issue("revoke");
    expect((await call()).status).toBe(401);
    expect((await issue("mint")).status).toBe(410);
  } finally {
    await gateway.close();
    await upstream.stop(true);
  }
});
