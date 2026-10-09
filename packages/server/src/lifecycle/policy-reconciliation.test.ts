import { expect, test } from "bun:test";
import { createTestStoreFactory } from "@pstdio/pocketcoder-db/testing";
import { authed, createTestBody, createTestServer } from "../testing/test-server.test";
import { PolicyReconciliation } from "./policy-reconciliation";

const createStore = createTestStoreFactory();

test("policy reconciliation retries terminal reservations after a lost response and restart", async () => {
  const runtime = await createTestServer(await createStore(), { globalActiveWorkspaces: 0 });
  const created = await runtime.app.request(
    "/v1/workspaces",
    authed(runtime.token, {
      method: "POST",
      headers: { "idempotency-key": "reconciliation" },
      body: createTestBody("task"),
    }),
  );
  const workspace = (await created.json()) as { id: string };
  await runtime.app.request(`/v1/workspaces/${workspace.id}/cancel`, authed(runtime.token, { method: "POST" }));
  let attempts = 0;
  let pending = true;
  const snapshots: Record<string, unknown>[] = [];
  const policy = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      expect(request.headers.get("authorization")).toBe("Bearer test-runtime-control-token");
      if (new URL(request.url).pathname.endsWith("/pending")) {
        return Response.json({ workspace_ids: pending ? [workspace.id] : [] });
      }
      const snapshot = (await request.json()) as Record<string, unknown>;
      snapshots.push(snapshot);
      attempts++;
      if (attempts === 1) return new Response("unavailable", { status: 503 });
      pending = false;
      return Response.json({ workspace_id: workspace.id, released: true });
    },
  });
  try {
    const createWorker = () =>
      new PolicyReconciliation(runtime.store, `${policy.url}v1/admission`, "test-runtime-control-token");
    await expect(createWorker().tick()).rejects.toThrow("Policy reconciliation unavailable");
    await createWorker().tick();
    await createWorker().tick();
    expect(snapshots).toHaveLength(2);
    expect(snapshots[1]).toMatchObject({
      workspace_id: workspace.id,
      state: "canceled",
      launch_attempts: 0,
      provider_ref: null,
    });
    expect(snapshots[1]).not.toHaveProperty("launchInput");
    expect(snapshots[1]).not.toHaveProperty("registrationDigest");
  } finally {
    await policy.stop(true);
  }
});
