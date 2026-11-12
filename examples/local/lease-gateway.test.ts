import { expect, test } from "bun:test";
import { startLeaseGateway } from "./lease-gateway";

test("gateway credentials are bound to one live workspace lease and revocation survives a late mint", async () => {
  const upstream = Bun.serve({
    port: 0,
    fetch: (req) => Response.json({ authorization: req.headers.get("authorization") }),
  });
  const gateway = await startLeaseGateway({ upstreamUrl: upstream.url.toString(), upstreamBearer: "host-only" });
  const identity = {
    session_id: crypto.randomUUID(),
    generation: 1,
    profile: "chat",
    owner: "user",
    group: "user",
    slot: "gateway",
    request_id: crypto.randomUUID(),
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
    const minted = (await (await issue("mint")).json()) as { credential: string };
    expect(minted.credential).not.toBe("host-only");
    const call = () =>
      fetch(gateway.url + "/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${minted.credential}` },
        body: "{}",
      });
    expect(await (await call()).json()).toEqual({ authorization: "Bearer host-only" });
    const fresh = (await (await issue("mint")).json()) as { credential: string };
    expect(fresh.credential).not.toBe(minted.credential);
    await issue("revoke");
    expect((await call()).status).toBe(401);
    const late = (await (await issue("mint")).json()) as { credential: string };
    expect(
      (
        await fetch(gateway.url + "/v1/chat/completions", {
          method: "POST",
          headers: { authorization: `Bearer ${late.credential}` },
          body: "{}",
        })
      ).status,
    ).toBe(401);
  } finally {
    await gateway.close();
    await upstream.stop(true);
  }
});
