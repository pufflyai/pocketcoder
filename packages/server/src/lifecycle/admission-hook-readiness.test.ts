import { expect, test } from "bun:test";
import { createTestStoreFactory } from "@pstdio/pocketcoder-db/testing";
import { createTestBody } from "../testing/test-server.test";
import { startControllerWithAdmissionHook, waitFor } from "./admission-hook-fixture";

const createStore = createTestStoreFactory();

type Controller = Awaited<ReturnType<typeof startControllerWithAdmissionHook>>;

async function readyz(controller: Controller) {
  const response = await fetch(`${controller.url}/readyz`);
  const body = (await response.json()) as { checks: Record<string, string> };
  return { status: response.status, checks: body.checks };
}

async function createWorkspace(controller: Controller, externalId: string) {
  const response = await controller.request("/v1/workspaces", controller.token, {
    method: "POST",
    headers: { "idempotency-key": externalId },
    body: createTestBody(externalId),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

async function workspace(controller: Controller, id: string) {
  return (await (await controller.request(`/v1/workspaces/${id}`, controller.token)).json()) as {
    state: string;
    reason_code: string | null;
  };
}

test("a live controller serves admin, principal and conversation reads while its admission hook is down", async () => {
  const controller = await startControllerWithAdmissionHook(await createStore());
  try {
    await waitFor(
      async () => (await readyz(controller)).checks["policy-reconciliation"] === "failed",
      "readiness to report the hook",
    );
    expect((await fetch(`${controller.url}/livez`)).status).toBe(200);
    expect(await readyz(controller)).toMatchObject({ status: 503, checks: { "policy-reconciliation": "failed" } });

    const created = await controller.request("/v1/principals", undefined, {
      method: "POST",
      body: JSON.stringify({ name: "late-tenant", scopes: ["workspaces:read"], templates: ["fixture-echo"] }),
    });
    expect(created.status).toBe(201);
    const listed = await controller.request("/v1/principals");
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ name: "test-backend", templates: ["fixture-echo", "fixture-terminal"] }),
        expect.objectContaining({ name: "late-tenant", templates: ["fixture-echo"] }),
      ]),
    });

    // Launches keep queueing with a visible reason; nothing reaches the provider.
    const id = await createWorkspace(controller, "while-hook-down");
    await waitFor(
      async () => (await workspace(controller, id)).reason_code === "admission_unavailable",
      "admission_unavailable feedback",
    );
    expect(await workspace(controller, id)).toMatchObject({ state: "queued" });
    expect(controller.driver.inputFor(id)).toBeUndefined();
    const conversation = await controller.request(`/v1/workspaces/${id}/conversation`, controller.token);
    expect(conversation.status).toBe(200);
  } finally {
    await controller.stop();
  }
}, 15_000);

test("the hook reads its configuration from a live controller and admission resumes without a restart", async () => {
  const controller = await startControllerWithAdmissionHook(await createStore());
  try {
    const id = await createWorkspace(controller, "queued-before-hook");
    await waitFor(
      async () => (await workspace(controller, id)).reason_code === "admission_unavailable",
      "admission_unavailable feedback",
    );
    expect((await readyz(controller)).status).toBe(503);

    await controller.startHook();
    expect(controller.hook.state.principals?.length).toBeGreaterThan(0);

    await waitFor(async () => (await readyz(controller)).status === 200, "readiness after the hook starts");
    await waitFor(async () => controller.driver.inputFor(id) !== undefined, "the queued launch to be admitted");
    expect((await workspace(controller, id)).reason_code).toBeNull();
  } finally {
    await controller.stop();
  }
}, 15_000);

test("policy reconciliation stays fail-closed while admission works, until the hook proves termination", async () => {
  const controller = await startControllerWithAdmissionHook(await createStore());
  try {
    const stopped = await createWorkspace(controller, "unproven-termination");
    expect(
      (await controller.request(`/v1/workspaces/${stopped}/cancel`, controller.token, { method: "POST" })).status,
    ).toBe(200);
    controller.hook.state.pending = [stopped];
    controller.hook.state.unproven.add(stopped);

    // Down: nothing is reported as reconciled and readiness never passes.
    await waitFor(
      async () => (await readyz(controller)).checks["policy-reconciliation"] === "failed",
      "readiness to report the hook",
    );
    expect(controller.hook.state.reconciled).toEqual([]);

    await controller.startHook();
    const admitted = await createWorkspace(controller, "admitted-while-unproven");
    await waitFor(async () => controller.driver.inputFor(admitted) !== undefined, "admission while unproven");
    await waitFor(async () => controller.hook.state.reconciled.length >= 2, "reconciliation retries");
    expect(await readyz(controller)).toMatchObject({ status: 503, checks: { "policy-reconciliation": "failed" } });

    controller.hook.state.unproven.delete(stopped);
    await waitFor(async () => (await readyz(controller)).status === 200, "readiness after termination is proven");
    expect(controller.hook.state.pending).toEqual([]);
  } finally {
    await controller.stop();
  }
}, 15_000);
