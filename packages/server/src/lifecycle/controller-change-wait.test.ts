// Proves real cancelled workspace change polls settle without poisoning physical controller ownership.
import { expect, test } from "bun:test";
import { loadConfig } from "../config/config";
import { authed, createTestBody, createTestServer } from "../testing/test-server.test";
import { startControllerListener } from "./controller-listener";

test("a disconnected change poll settles before controller lease release", async () => {
  const built = await createTestServer();
  let entered!: () => void;
  let settled!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const finished = new Promise<void>((resolve) => {
    settled = resolve;
  });
  const originalWait = built.store.waitForWorkspaceChange.bind(built.store);
  built.store.waitForWorkspaceChange = async (...args) => {
    entered();
    try {
      await originalWait(...args);
    } finally {
      settled();
    }
  };
  const running = startControllerListener(
    {
      ...loadConfig({ POCKETCODER_STORE: "memory", POCKETCODER_PEPPER: "synthetic-change-owner" }),
      listenHost: "127.0.0.1",
      listenPort: 0,
    },
    built,
    { store: built.store, timers: [] },
  );
  const caller = new AbortController();
  try {
    const created = await fetch(
      `${running.url}/v1/workspaces`,
      authed(built.token, {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
        body: createTestBody(),
      }),
    );
    expect(created.status).toBe(201);
    const workspace = (await created.json()) as { id: string; change_cursor: number };
    const row = await built.store.getWorkspace(workspace.id);
    if (!row) throw new Error("missing synthetic workspace");
    const poll = fetch(
      `${running.url}/v1/workspaces/${workspace.id}/changes?after=${row.changeSeq}&wait=15`,
      authed(built.token, { signal: caller.signal }),
    ).catch(() => undefined);
    await started;
    caller.abort(new Error("synthetic_caller_left"));
    await poll;
    await finished;

    expect(await running.quiesce(AbortSignal.timeout(1000))).toBeUndefined();
  } finally {
    caller.abort();
    await running.stop();
  }
});
