import { expect, test } from "bun:test";
import { createManagerApp } from "../app";
import { ManagerStore } from "../database/store";
import { managerMonitoring } from "../monitoring/metrics";

test("a finite metrics credential can scrape without account administration authority", async () => {
  const store = await ManagerStore.create();
  try {
    const token = await store.createOperator(new Date(Date.now() + 60_000), "metrics");
    const app = createManagerApp(store, {
      controllerImage: `controller.test/server@sha256:${"a".repeat(64)}`,
      runtimeClassName: "pc-runc",
    });
    const headers = { authorization: `Bearer ${token}` };
    expect((await app.request("/metrics")).status).toBe(401);
    expect((await app.request("/v1/accounts", { headers })).status).toBe(403);
    expect((await app.request("/v1/accounts", { method: "POST", headers, body: '{"name":"forbidden"}' })).status).toBe(
      403,
    );
    const metrics = await app.request("/metrics", { headers });
    expect(metrics.status).toBe(200);
    expect(metrics.headers.get("content-type")).toContain("text/plain");
    const body = await metrics.text();
    expect(body).toContain("pocketcoder_manager_pending_operations 0");
    expect(body).not.toContain(token);
    expect(await store.listAccounts()).toEqual([]);
  } finally {
    await store.close();
  }
}, 20_000);

test("durable pending work is reported without account details and unknown probes stay unknown", async () => {
  const store = await ManagerStore.create();
  const monitoring = managerMonitoring(store);
  try {
    const created = await store.createAccount(
      "private-request",
      { name: "private-account-name" },
      () => ({
        controllerImage: `controller.test/server@sha256:${"a".repeat(64)}`,
        runtimeClassName: "pc-runc",
        offNodeBackups: true,
      }),
      new Date(Date.now() + 60_000),
    );
    const body = await monitoring.metrics();
    expect(body).toContain("pocketcoder_manager_pending_operations 1");
    expect(body).toContain("pocketcoder_cell_observed 0");
    expect(body).toContain(`pocketcoder_account_backup_present{account="${created.account.id}"} 0`);
    expect(body).toContain(`pocketcoder_account_backup_age_seconds{account="${created.account.id}"} NaN`);
    expect(body).not.toContain("private-account-name");
    expect(body).not.toContain("private-request");
    expect(body).not.toContain(created.account.namespace);
    expect(body).not.toContain(created.operation.id);
  } finally {
    await monitoring.close();
    await store.close();
  }
}, 20_000);
