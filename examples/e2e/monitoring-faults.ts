import { randomUUID } from "node:crypto";
import { ErrorEnvelopeSchema } from "@pstdio/pocketcoder-contracts";
import { waitFor } from "./local-process";
import type { managedLifecycleFixture } from "./managed-lifecycle-fixture";
import { prepareManagedWarm } from "./managed-warm";
import { monitoringContainerSignal } from "./monitoring-container-signal";
import type { monitoringFixture } from "./monitoring-fixture";

export async function monitoringFaults(input: {
  f: Awaited<ReturnType<typeof managedLifecycleFixture>>;
  m: Awaited<ReturnType<typeof monitoringFixture>>;
  account: { id: string; namespace: string };
  other: { id: string; namespace: string };
  request: (path: string, init?: RequestInit) => Promise<Response>;
  workspace: string | undefined;
  backup: (id: string) => Promise<void>;
  failStorageWrites: (enabled: boolean) => Promise<void>;
  reconnect: () => Promise<void>;
  template: string;
  ownerToken: string;
}) {
  const { f, m, account, request } = input;
  if (!input.workspace) throw new Error("Heartbeat fixture has no real workspace");
  const signal = await monitoringContainerSignal(f, account.namespace, `pocketcoder.workspace=${input.workspace}`);
  try {
    await signal("SIGSTOP");
    await m.firing("heartbeat");
  } finally {
    await signal("SIGCONT");
  }
  await m.resolved("heartbeat");
  const role = JSON.parse(await f.cluster.kube(["-n", account.namespace, "get", "role", "controller", "-o", "json"]));
  const deny = {
    ...role,
    rules: role.rules.map((rule: { verbs: string[] }) => ({
      ...rule,
      verbs: rule.verbs.filter((verb) => verb !== "delete"),
    })),
  };
  try {
    await f.cluster.kube(["replace", "-f", "-"], JSON.stringify(deny));
    await request(`/v1/workspaces/${input.workspace}/cancel`, { method: "POST" });
    await m.firing("cleanup");
  } finally {
    delete role.metadata.resourceVersion;
    await f.cluster.kube(["apply", "-f", "-"], JSON.stringify(role));
  }
  await m.resolved("cleanup");
  for (const node of f.cluster.nodes) await f.cluster.kube(["cordon", node]);
  try {
    await m.firing("capacity");
  } finally {
    for (const node of f.cluster.nodes) await f.cluster.kube(["uncordon", node]);
  }
  await m.resolved("capacity");
  await f.cluster.kube(["-n", account.namespace, "scale", "deployment/controller", "--replicas=0"]);
  try {
    await m.firing("observation");
    const other = await m.query(`pocketcoder_account_observed{account="${input.other.id}"}`);
    const age = await m.query(`pocketcoder_account_observation_age_seconds{account="${input.other.id}"}`);
    if (other !== 1 || age > 15) throw new Error("A missing account controller blocked its healthy peer");
  } finally {
    await f.cluster.kube(["-n", account.namespace, "scale", "deployment/controller", "--replicas=1"]);
    await f.cluster.kube(["-n", account.namespace, "rollout", "status", "deployment/controller", "--timeout=120s"]);
    await input.reconnect();
  }
  await m.resolved("observation");
  await m.firing("backup");
  await input.backup(account.id);
  await input.backup(input.other.id);
  await m.resolved("backup");
  const principalList = (await (await request("/v1/principals")).json()) as { items: { id: string; name: string }[] };
  const principal = principalList.items.find((row) => row.name === "owner");
  if (!principal) throw new Error("Journal owner principal is missing");
  const childResponse = await request(`/v1/principals/${principal.id}/keys`, {
    method: "POST",
    body: JSON.stringify({
      request_id: randomUUID(),
      scopes: ["keys:read"],
      expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    }),
  });
  const child = (await childResponse.json()) as { key: { id: string }; token: string };
  if (!childResponse.ok || !child.token) throw new Error("Journal finite test key issuance failed");
  try {
    await input.failStorageWrites(true);
    const revoked = await request(`/v1/principals/${principal.id}/keys/${child.key.id}`, { method: "DELETE" });
    if (ErrorEnvelopeSchema.parse(await revoked.json()).error.code !== "journal.pending")
      throw new Error("The real journal write fault did not leave the enforced revocation pending");
    await m.firing("journal");
  } finally {
    await input.failStorageWrites(false);
  }
  await waitFor(
    async () => {
      const response = await request(`/v1/principals/${principal.id}/keys/${child.key.id}`, { method: "DELETE" });
      return response.ok;
    },
    30_000,
    "same journal revocation acknowledged",
  );
  if (
    (
      await fetch(new URL("/v1/principals", new URL(await f.connect(account.namespace))), {
        headers: { authorization: `Bearer ${child.token}` },
      })
    ).status !== 401
  )
    throw new Error("Journal recovery revived revoked authority");
  await input.reconnect();
  await input.backup(account.id);
  await input.backup(input.other.id);
  await m.resolved("journal");
  // A real exited warm container leaves provider cleanup pending while RBAC denies deletion.
  await prepareManagedWarm(f, account.namespace, input.template, input.ownerToken);
  await input.reconnect();
  const currentRole = JSON.parse(
    await f.cluster.kube(["-n", account.namespace, "get", "role", "controller", "-o", "json"]),
  );
  try {
    await f.cluster.kube(["replace", "-f", "-"], JSON.stringify({ ...currentRole, rules: deny.rules }));
    const stopWarm = await monitoringContainerSignal(f, account.namespace, "pocketcoder.pool-runtime");
    await stopWarm("SIGKILL");
    await m.firing("cleanup");
  } finally {
    delete currentRole.metadata.resourceVersion;
    await f.cluster.kube(["apply", "-f", "-"], JSON.stringify(currentRole));
  }
  await m.resolved("cleanup");
}
