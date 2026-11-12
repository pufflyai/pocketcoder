import { expect, test } from "bun:test";
import { onefinCredentials } from "./credentials";

const token = (jti: string, exp: number) =>
  `test.${Buffer.from(JSON.stringify({ jti, exp, task_id: "task" })).toString("base64url")}.test`;
test("Onefin redeems one-use input, rotates its scoped token, and revokes the latest token", async () => {
  const calls: { path: string; authorization: string | null; body: unknown }[] = [];
  const old = token("old", Date.now() / 1000 + 30),
    fresh = token("fresh", Date.now() / 1000 + 3600);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      calls.push({ path, authorization: request.headers.get("authorization"), body: await request.json() });
      return Response.json(path.endsWith("bootstrap/") ? { access_token: old } : { access_token: fresh });
    },
  });
  try {
    const credentials = await onefinCredentials({
      onefin_api_url: server.url.toString(),
      bootstrap_code: "one-use-test",
      task_id: "task",
    });
    expect(await credentials.accessToken()).toBe(fresh);
    expect(await credentials.accessToken()).toBe(fresh);
    await credentials.revoke();
    expect(calls.map((call) => call.path)).toEqual([
      "/api/auth/agent_session/bootstrap/",
      "/api/auth/agent_session/",
      "/api/auth/agent_session/revoke/",
    ]);
    expect(calls[0]?.body).toEqual({ code: "one-use-test" });
    expect(calls[2]).toMatchObject({ authorization: `Bearer ${fresh}`, body: { jti: "fresh" } });
  } finally {
    await server.stop(true);
  }
});

test("closing during refresh revokes the new lease and prevents later reads", async () => {
  const refreshing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const revoked: string[] = [];
  const old = token("old", Date.now() / 1000 + 1),
    fresh = token("fresh", Date.now() / 1000 + 3600);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.endsWith("bootstrap/")) return Response.json({ access_token: old });
      if (path.endsWith("revoke/")) {
        revoked.push(((await request.json()) as { jti: string }).jti);
        return new Response(null, { status: 204 });
      }
      refreshing.resolve();
      await release.promise;
      return Response.json({ access_token: fresh });
    },
  });
  try {
    const credentials = await onefinCredentials({
      onefin_api_url: server.url.toString(),
      bootstrap_code: "once",
      task_id: "task",
    });
    const reading = credentials.accessToken().then(
      () => true,
      () => false,
    );
    await refreshing.promise;
    const closing = credentials.revoke();
    release.resolve();
    await closing;
    expect(await reading).toBe(false);
    expect(revoked).toEqual(["fresh"]);
    await expect(credentials.accessToken()).rejects.toThrow("closed");
  } finally {
    release.resolve();
    await server.stop(true);
  }
});

test("a minted credential is revoked when its task binding is rejected", async () => {
  const revoked: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname.endsWith("revoke/")) {
        revoked.push(((await request.json()) as { jti: string }).jti);
        return new Response(null, { status: 204 });
      }
      return Response.json({ access_token: token("wrong-task", Date.now() / 1000 + 3600) });
    },
  });
  try {
    await expect(
      onefinCredentials({ onefin_api_url: server.url.toString(), bootstrap_code: "once", task_id: "another-task" }),
    ).rejects.toThrow("another task");
    expect(revoked).toEqual(["wrong-task"]);
  } finally {
    await server.stop(true);
  }
});
