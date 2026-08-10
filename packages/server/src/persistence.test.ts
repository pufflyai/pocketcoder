import { describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assertSupportedResume,
  insertReadyCheckpoint,
  server,
  waitFor,
} from "./persistence-support.test";
import { markReadyThroughAgent } from "./test-server.test";

describe("persistent workspace REST workflow", () => {
  test("reserves persistence operation capacity across concurrent requests", async () => {
    const testServer = await server({ maxConcurrentOperations: 1 });
    const checkpointId = await insertReadyCheckpoint(testServer);
    let releaseVerification = () => {};
    const verificationGate = new Promise<void>((resolve) => {
      releaseVerification = resolve;
    });
    let verificationCalls = 0;
    testServer.storageDriver.verifyCheckpoint = async (_ref, manifest) => {
      verificationCalls += 1;
      await verificationGate;
      return manifest;
    };

    const requests = Promise.allSettled(
      ["verify-capacity-a", "verify-capacity-b"].map((key) =>
        testServer.persistence.verify(testServer.principal, checkpointId, key),
      ),
    );
    await waitFor(async () => verificationCalls > 0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const observedCalls = verificationCalls;
    const observedIncomplete = await testServer.store.countIncompleteOperations();
    releaseVerification();
    const results = await requests;

    expect(observedCalls).toBe(1);
    expect(observedIncomplete).toBe(1);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
  });

  test("replays the original terminal error for a failed verification", async () => {
    const testServer = await server();
    const checkpointId = await insertReadyCheckpoint(testServer);
    testServer.storageDriver.verifyCheckpoint = async () => {
      throw new Error("corrupt fixture");
    };

    const verify = () =>
      testServer.request(`/v1/checkpoints/${checkpointId}/verify`, {
        method: "POST",
        headers: { "idempotency-key": "verify-corrupt" },
      });
    const first = await verify();
    const second = await verify();

    expect(first.status).toBe(409);
    expect(second.status).toBe(409);
    expect((await first.json()) as unknown).toMatchObject({
      error: { code: "checkpoint.corrupt" },
    });
    expect((await second.json()) as unknown).toMatchObject({
      error: { code: "checkpoint.corrupt" },
    });
  });
});

describe("persistent workspace preservation", () => {
  test("preserves, verifies, restores, and keeps forks independent", async () => {
    const testServer = await server();
    const createdResponse = await testServer.request("/v1/workspaces", {
      method: "POST",
      headers: { "idempotency-key": "create-persistent" },
      body: JSON.stringify({
        external_id: "persistent-source",
        template: { name: "fixture-persistent" },
      }),
    });
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json()) as { id: string };
    await testServer.scheduler.tick();
    await waitFor(async () => {
      const [workspace, storage] = await Promise.all([
        testServer.store.getWorkspace(created.id),
        testServer.store.getWorkspaceStorage(created.id),
      ]);
      return workspace?.providerRef != null && storage?.state === "ready";
    });
    const now = new Date();
    await testServer.store.transition(created.id, {
      from: ["provisioning"],
      to: "connected",
      at: now,
    });
    await testServer.store.transition(created.id, {
      from: ["connected"],
      to: "ready",
      at: now,
      patch: { readyAt: now, lastActivityAt: now },
    });
    const sourceStorage = await testServer.store.getWorkspaceStorage(created.id);
    expect(sourceStorage?.state).toBe("ready");
    const sourceRoot = String(sourceStorage?.providerRef.root);
    await mkdir(join(sourceRoot, "worktree", "src"), { recursive: true });
    await writeFile(
      join(sourceRoot, "worktree", "src", "state.ts"),
      "export const checkpointed = true;\n",
    );

    const preserve = await testServer.request(`/v1/workspaces/${created.id}/preserve`, {
      method: "POST",
      headers: { "idempotency-key": "preserve-1" },
      body: JSON.stringify({ label: "before-test" }),
    });
    expect(preserve.status).toBe(202);
    const preserveBody = (await preserve.json()) as {
      checkpoint: { id: string };
      operation: { id: string };
    };
    await waitFor(
      async () => (await testServer.store.getWorkspace(created.id))?.state === "preserved",
    );
    const checkpoint = await testServer.store.getCheckpoint(preserveBody.checkpoint.id);
    if (!checkpoint) throw new Error("expected preserve to create a checkpoint");
    expect(checkpoint?.state).toBe("ready");
    expect(checkpoint?.conversationRestore).toBe("filesystem_only");
    const historicalSource = await testServer.request(`/v1/workspaces/${created.id}`);
    expect((await historicalSource.json()) as unknown).toMatchObject({
      persistence: {
        conversation_restore: "filesystem_only",
        conversation_resume: { status: "unsupported", reason: "filesystem_only" },
      },
    });
    const unsupportedResume = await testServer.request(`/v1/workspaces/${created.id}/resume`, {
      method: "POST",
      headers: { "idempotency-key": "resume-unsupported" },
      body: JSON.stringify({ external_id: "must-not-be-created" }),
    });
    expect(unsupportedResume.status).toBe(409);
    expect((await unsupportedResume.json()) as unknown).toMatchObject({
      error: {
        code: "resume.unsupported",
        details: { reason: "filesystem_only", checkpoint_id: checkpoint.id },
      },
    });
    expect(
      (
        await testServer.store.listWorkspaces(
          (await testServer.store.listPrincipals())[0]?.id ?? "",
          { externalId: "must-not-be-created", limit: 10 },
        )
      ).length,
    ).toBe(0);
    await assertSupportedResume(testServer, created.id, checkpoint);
    expect(testServer.driver.stopped.length).toBeGreaterThan(0);
    expect(testServer.driver.terminated.length).toBeGreaterThan(0);

    const repeated = await testServer.request(`/v1/workspaces/${created.id}/preserve`, {
      method: "POST",
      headers: { "idempotency-key": "preserve-1" },
      body: JSON.stringify({ label: "before-test" }),
    });
    expect(repeated.status).toBe(202);
    expect(((await repeated.json()) as { checkpoint: { id: string } }).checkpoint.id).toBe(
      checkpoint.id,
    );

    const verify = await testServer.request(`/v1/checkpoints/${checkpoint.id}/verify`, {
      method: "POST",
      headers: { "idempotency-key": "verify-1" },
    });
    expect(verify.status).toBe(202);
    expect(((await verify.json()) as { state: string }).state).toBe("succeeded");

    const recreate = await testServer.request(`/v1/workspaces/${created.id}/recreate`, {
      method: "POST",
      headers: { "idempotency-key": "recreate-with-input" },
      body: JSON.stringify({
        external_id: "recreated-fork",
        launch_input: { bootstrap_token: "recreate-envelope" },
      }),
    });
    expect(recreate.status).toBe(202);
    const recreated = (await recreate.json()) as { workspace: { id: string } };
    expect((await testServer.store.getWorkspace(recreated.workspace.id))?.launchInput).toEqual({
      bootstrap_token: "recreate-envelope",
    });

    const oversizedRestore = await testServer.request(`/v1/checkpoints/${checkpoint.id}/restore`, {
      method: "POST",
      headers: { "idempotency-key": "restore-oversized" },
      body: JSON.stringify({
        external_id: "oversized-restore",
        launch_input: {
          value: "x".repeat(testServer.parsed.manifest.spec.maxLaunchInputBytes),
        },
      }),
    });
    expect(oversizedRestore.status).toBe(400);
    expect((await oversizedRestore.json()) as unknown).toMatchObject({
      error: { code: "validation.invalid" },
    });

    const restoreBody = {
      external_id: "restored-fork",
      launch_input: { bootstrap_token: "restore-envelope" },
    };
    const restore = await testServer.request(`/v1/checkpoints/${checkpoint.id}/restore`, {
      method: "POST",
      headers: { "idempotency-key": "restore-1" },
      body: JSON.stringify(restoreBody),
    });
    expect(restore.status).toBe(202);
    const restored = (await restore.json()) as {
      workspace: {
        id: string;
        origin_workspace_id: string;
        restored_from_checkpoint_id: string;
      };
      operation: { id: string };
    };
    expect(restored.workspace.id).not.toBe(created.id);
    expect(restored.workspace.origin_workspace_id).toBe(created.id);
    expect(restored.workspace.restored_from_checkpoint_id).toBe(checkpoint.id);
    const repeatedRestore = await testServer.request(`/v1/checkpoints/${checkpoint.id}/restore`, {
      method: "POST",
      headers: { "idempotency-key": "restore-1" },
      body: JSON.stringify(restoreBody),
    });
    expect(repeatedRestore.status).toBe(202);
    expect(((await repeatedRestore.json()) as { workspace: { id: string } }).workspace.id).toBe(
      restored.workspace.id,
    );
    const changedInputReplay = await testServer.request(
      `/v1/checkpoints/${checkpoint.id}/restore`,
      {
        method: "POST",
        headers: { "idempotency-key": "restore-1" },
        body: JSON.stringify({
          ...restoreBody,
          launch_input: { bootstrap_token: "rotated-envelope" },
        }),
      },
    );
    expect(changedInputReplay.status).toBe(409);
    expect((await changedInputReplay.json()) as unknown).toMatchObject({
      error: { code: "idempotency.conflict" },
    });
    await testServer.scheduler.tick();
    await waitFor(async () => {
      const operation = await testServer.store.getOperation(restored.operation.id);
      return operation?.state === "succeeded";
    });
    const restoredStorage = await testServer.store.getWorkspaceStorage(restored.workspace.id);
    const restoredFile = join(
      String(restoredStorage?.providerRef.root),
      "worktree",
      "src",
      "state.ts",
    );
    expect(await readFile(restoredFile, "utf8")).toContain("checkpointed = true");
    await writeFile(restoredFile, "fork mutation\n");
    await testServer.storageDriver.verifyCheckpoint(
      checkpoint?.providerRef as never,
      checkpoint?.manifest as never,
    );
    expect(testServer.driver.inputFor(restored.workspace.id)?.launch_mode).toBe("restore");
    expect(testServer.driver.inputFor(restored.workspace.id)?.launch_input).toEqual({
      bootstrap_token: "restore-envelope",
    });
    expect((await testServer.store.getWorkspace(restored.workspace.id))?.launchInput).toEqual({
      bootstrap_token: "restore-envelope",
    });
    await markReadyThroughAgent(testServer, restored.workspace.id);
    expect((await testServer.store.getWorkspace(restored.workspace.id))?.launchInput).toBeNull();
  });
});

describe("persistent workspace outputs", () => {
  test("persists only declared, bounded output metadata", async () => {
    const testServer = await server();
    const createdResponse = await testServer.request("/v1/workspaces", {
      method: "POST",
      headers: { "idempotency-key": "output-workspace" },
      body: JSON.stringify({
        external_id: "output-workspace",
        template: { name: "fixture-persistent" },
      }),
    });
    const workspace = (await createdResponse.json()) as { id: string };
    await testServer.persistence.publishOutput(workspace.id, "commit", "a".repeat(40));
    await expect(
      testServer.persistence.publishOutput(workspace.id, "undeclared", "value"),
    ).rejects.toThrow("not declared");
    const outputs = await testServer.request(`/v1/workspaces/${workspace.id}/outputs`);
    expect(outputs.status).toBe(200);
    expect(((await outputs.json()) as { items: Array<{ name: string }> }).items[0]?.name).toBe(
      "commit",
    );
  });
});
