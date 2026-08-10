import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { issueMachineKey } from "@pstdio/pocketcoder-auth";
import { FilesystemStorageDriver } from "@pstdio/pocketcoder-drivers";
import { MemoryStore } from "@pstdio/pocketcoder-memory-store";
import { DEFAULT_LIMITS } from "@pstdio/pocketcoder-runtime-core";
import { supervise } from "@pstdio/pocketcoder-supervisor";
import { FakeDriver } from "@pstdio/pocketcoder-testkit";
import { buildServer } from "./app";
import {
  createSourceFixture,
  e2eTemplate,
  HARNESS_SCRIPT,
  verifyAttachmentFlow,
  verifySourceSecretBoundary,
  waitFor,
} from "./e2e-test-support";

const PEPPER = "e2e-pepper";

describe("end-to-end workspace lifecycle", () => {
  const cleanups: Array<() => void> = [];
  // Ensures the supervisor and its harness child are stopped even when an
  // assertion fails mid-flight, so no process leaks across runs.
  let teardown: (() => Promise<void>) | null = null;
  afterAll(async () => {
    await teardown?.().catch(() => {});
    for (const fn of cleanups) fn();
  });

  test(
    "create, setup, harness, ready, converse, cancel",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "pocketcoder-e2e-"));
      const harnessPath = join(dir, "harness.ts");
      const sourceCredential = "short-lived-git-token";
      const { setupPath, setupMarker, harnessEnvironment, worktree } =
        await createSourceFixture(dir);
      await writeFile(harnessPath, HARNESS_SCRIPT);

      const template = e2eTemplate({ setupPath, harnessPath, harnessEnvironment, worktree });

      const store = new MemoryStore();
      const driver = new FakeDriver();
      const principal = await store.createPrincipal("e2e", ["admin"], ["*"]);
      const key = issueMachineKey(PEPPER);
      await store.insertMachineKey({
        id: key.id,
        principalId: principal.id,
        secretDigest: key.secretDigest,
        scopes: ["admin"],
        createdAt: new Date(),
        expiresAt: null,
        revokedAt: null,
        lastUsedAt: null,
      });
      await store.upsertTemplate({
        name: "e2e-echo",
        version: "1.0.0",
        digest: template.digest,
        description: null,
        spec: template.manifest.spec,
      });

      const storageDriver = new FilesystemStorageDriver({
        workspaceRoot: join(dir, "storage"),
        checkpointRoot: join(dir, "checkpoints"),
      });
      const secretResolver = {
        resolve: async () => [],
        resolveSourceCredential: async () => sourceCredential,
      };
      const { app, websocket, scheduler } = buildServer({
        store,
        driver,
        storageDriver,
        secretResolver,
        pepper: PEPPER,
        limits: DEFAULT_LIMITS,
        workspaceServerUrl: "placeholder",
      });
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: app.fetch,
        websocket,
      });
      cleanups.push(() => server.stop(true));
      const baseUrl = `http://127.0.0.1:${server.port}`;
      const authHeaders = {
        authorization: `Bearer ${key.token}`,
        "content-type": "application/json",
      };

      // 1. Create the workspace through the REST API.
      const createRes = await fetch(`${baseUrl}/v1/workspaces`, {
        method: "POST",
        headers: { ...authHeaders, "idempotency-key": "e2e-1" },
        body: JSON.stringify({
          external_id: "e2e-task",
          template: { name: "e2e-echo" },
          source: { kind: "git", repository: "app", revision: "main" },
        }),
      });
      expect(createRes.status).toBe(201);
      const ws = (await createRes.json()) as { id: string; state: string };
      expect(ws.state).toBe("queued");

      // 2. Scheduler admits it through the (fake) driver.
      await scheduler.tick();
      const input = driver.inputFor(ws.id);
      expect(input).toBeDefined();
      expect(driver.created[0]?.secrets).toEqual([]);

      // 3. Start the real supervisor with the provider input, pointed
      // at the real WSS endpoint. HOME points at the test directory so
      // supervisor-owned attachment storage stays inside the sandbox.
      const originalHome = process.env.HOME;
      process.env.HOME = dir;
      cleanups.push(() => {
        process.env.HOME = originalHome;
      });
      const inputPath = join(dir, "input.json");
      await writeFile(inputPath, JSON.stringify({ ...input, server_url: baseUrl }));
      const supervisorDone = supervise(inputPath);
      teardown = async () => {
        await fetch(`${baseUrl}/v1/workspaces/${ws.id}/cancel`, {
          method: "POST",
          headers: authHeaders,
        }).catch(() => {});
        await Promise.race([supervisorDone, new Promise((resolve) => setTimeout(resolve, 8000))]);
      };

      // 4. The workspace becomes ready after setup + harness health.
      await waitFor(
        async () => (await store.getWorkspace(ws.id))?.state === "ready",
        15_000,
        "workspace ready",
      );
      await verifySourceSecretBoundary(
        store,
        ws.id,
        setupMarker,
        harnessEnvironment,
        sourceCredential,
      );

      // 5. Converse through the relay.
      const post = await fetch(`${baseUrl}/v1/workspaces/${ws.id}/services/agent/message`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ content: "hello agent" }),
      });
      expect(post.status).toBe(200);
      const messages = await waitFor(
        async () => {
          const res = await fetch(`${baseUrl}/v1/workspaces/${ws.id}/services/agent/messages`, {
            headers: authHeaders,
          });
          if (!res.ok) return null;
          const body = (await res.json()) as { messages: Array<{ content: string }> };
          return body.messages.length >= 2 ? body.messages : null;
        },
        10_000,
        "agent echo",
      );
      expect(messages[1]?.content).toBe("echo: hello agent");

      // The harness emits canonical transcript records on stdout. The real
      // supervisor forwards them over WSS and the server persists them.
      const conversation = await waitFor(
        async () => {
          const res = await fetch(`${baseUrl}/v1/workspaces/${ws.id}/conversation`, {
            headers: authHeaders,
          });
          if (!res.ok) return null;
          const body = (await res.json()) as {
            items: Array<{ role: string; content: string; seq: number }>;
          };
          return body.items.length >= 2 ? body.items : null;
        },
        10_000,
        "durable conversation",
      );
      expect(conversation.map(({ role, content }) => ({ role, content }))).toEqual([
        { role: "user", content: "hello agent" },
        { role: "assistant", content: "echo: hello agent" },
      ]);
      expect(conversation.map(({ seq }) => seq)).toEqual([1, 2]);

      // 5b. Attachments flow end-to-end through the real supervisor.
      await verifyAttachmentFlow(baseUrl, ws.id, authHeaders, dir);

      // 6. Undeclared routes stay rejected even on a live workspace.
      const forbidden = await fetch(`${baseUrl}/v1/workspaces/${ws.id}/services/agent/admin`, {
        headers: authHeaders,
      });
      expect(forbidden.status).toBe(422);

      // 7. Cancel; the supervisor shuts the harness down and the
      // workspace reaches the canceled terminal state.
      const cancelRes = await fetch(`${baseUrl}/v1/workspaces/${ws.id}/cancel`, {
        method: "POST",
        headers: authHeaders,
      });
      expect(cancelRes.status).toBe(200);
      await waitFor(
        async () => (await store.getWorkspace(ws.id))?.state === "canceled",
        15_000,
        "workspace canceled",
      );
      const exitCode = await supervisorDone;
      teardown = null;
      expect(typeof exitCode).toBe("number");

      // Terminal workspaces retain transcript history for the configured
      // retention window.
      const retainedRes = await fetch(`${baseUrl}/v1/workspaces/${ws.id}/conversation`, {
        headers: authHeaders,
      });
      expect(retainedRes.status).toBe(200);
      const retained = (await retainedRes.json()) as { items: unknown[] };
      expect(retained.items).toHaveLength(4);

      // 8. Outbox recorded the full lifecycle.
      const events = await store.claimDueEvents(new Date(), 100);
      const types = events.map((e) => e.eventType);
      for (const expected of [
        "workspace.queued",
        "workspace.provisioning",
        "workspace.connected",
        "workspace.ready",
        "workspace.terminating",
        "workspace.canceled",
      ]) {
        expect(types).toContain(expected);
      }

      // 9. Logs captured harness output through the supervisor.
      const history = await store.listStateHistory(ws.id);
      expect(history[0]?.toState).toBe("queued");
    },
    { timeout: 60_000 },
  );
});
