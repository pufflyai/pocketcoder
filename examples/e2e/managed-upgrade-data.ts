import { randomUUID } from "node:crypto";
import { RestoreResponseSchema, WorkspaceResourceSchema } from "@pstdio/pocketcoder-contracts";
import { createHarnessWorkspace, runHarnessE2E } from "./contract";
import { waitFor } from "./local-process";
import type { managedLifecycleFixture } from "./managed-lifecycle-fixture";

type Fixture = Awaited<ReturnType<typeof managedLifecycleFixture>>;
export async function upgradeData(fixture: Fixture, account: { id: string; namespace: string }) {
  const firstRequest = randomUUID();
  const expiresAt = new Date(Date.now() + 25 * 60_000).toISOString();
  async function owner(requestId: string, replacesRequestId?: string) {
    const response = await fixture.request(`/v1/accounts/${account.id}/owner`, {
      method: "POST",
      body: JSON.stringify({
        request_id: requestId,
        expires_at: expiresAt,
        ...(replacesRequestId ? { replaces_request_id: replacesRequestId } : {}),
      }),
    });
    const result = (await response.json()) as { token: string; key: { id: string } };
    if (!response.ok || !result.token) throw new Error("Upgrade fixture owner issuance failed.");
    return result;
  }
  const firstOwner = await owner(firstRequest);
  let token = firstOwner.token;
  let url = await fixture.connect(account.namespace);
  const request = (path: string, input: RequestInit = {}) =>
    fetch(`${url}${path}`, {
      ...input,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...input.headers },
    });
  const template = await fixture.cluster.echoTemplate(fixture.workspace.image);
  template.metadata.name = "upgrade-kept-work";
  template.spec.resources.ephemeralStorage = "128Mi";
  template.spec.persistence = { mounts: [{ name: "work", target: "/work", maxBytes: 1024 ** 2, maxFiles: 100 }] };
  template.spec.setup = [
    {
      name: "exact-saved-bytes",
      runOn: ["restore"],
      command: [
        "bun",
        "-e",
        "if(await Bun.file('/work/saved.txt').text()!=='upgrade saved bytes')throw Error('Upgrade lost saved bytes')",
      ],
      timeoutSeconds: 5,
    },
  ];
  if (!(await request("/v1/templates", { method: "POST", body: JSON.stringify({ manifest: template }) })).ok)
    throw new Error("Upgrade fixture template import failed.");
  const workspace = await createHarnessWorkspace({ baseUrl: url, key: token, template: template.metadata.name });
  const pods = JSON.parse(
    await fixture.cluster.kube([
      "-n",
      account.namespace,
      "get",
      "pods",
      "-l",
      `pocketcoder.workspace=${workspace.workspaceId}`,
      "-o",
      "json",
    ]),
  ).items;
  await fixture.cluster.kube([
    "-n",
    account.namespace,
    "exec",
    pods[0].metadata.name,
    "--",
    "bun",
    "-e",
    "await Bun.write('/work/saved.txt','upgrade saved bytes')",
  ]);
  const preserved = await workspace.request(`/v1/workspaces/${workspace.workspaceId}/preserve`, {
    method: "POST",
    headers: { "idempotency-key": randomUUID() },
    body: "{}",
  });
  const checkpoint = ((await preserved.json()) as { checkpoint: { id: string } }).checkpoint;
  if (preserved.status !== 202) throw new Error("Upgrade fixture preserve failed.");
  await waitFor(
    async () =>
      ((await (await request(`/v1/checkpoints/${checkpoint.id}`)).json()) as { state: string }).state === "ready",
    30_000,
    "upgrade saved checkpoint",
  );
  return {
    checkpointId: checkpoint.id,
    keyId: firstOwner.key.id,
    async verify(revoked = false) {
      url = await fixture.connect(account.namespace);
      if (revoked) {
        if ((await request("/v1/keys")).status !== 401) throw new Error("Upgrade restore revived a revoked key.");
        token = (await owner(randomUUID(), firstRequest)).token;
      }
      const restored = RestoreResponseSchema.parse(
        await (
          await request(`/v1/checkpoints/${checkpoint.id}/restore`, {
            method: "POST",
            headers: { "idempotency-key": randomUUID() },
            body: JSON.stringify({ external_id: randomUUID() }),
          })
        ).json(),
      );
      await waitFor(
        async () =>
          WorkspaceResourceSchema.parse(await (await request(`/v1/workspaces/${restored.workspace.id}`)).json())
            .state === "ready",
        30_000,
        "exact bytes after account upgrade",
      );
      if (!(await request(`/v1/workspaces/${restored.workspace.id}/cancel`, { method: "POST" })).ok)
        throw new Error("Upgrade restored workspace cleanup failed.");
      const report = await runHarnessE2E({
        baseUrl: url,
        key: token,
        template: template.metadata.name,
        prompt: "upgrade canary",
        expectedResponse: "echo: upgrade canary",
        readyTimeoutMs: 30_000,
        messageTimeoutMs: 30_000,
        pollIntervalMs: 100,
      });
      console.log(
        JSON.stringify({
          upgradeCanary: {
            account: account.id,
            checkpoint: checkpoint.id,
            savedBytes: true,
            report,
            revokedKeyStayedRevoked: revoked,
          },
        }),
      );
    },
    async firstWritePresent() {
      url = await fixture.connect(account.namespace);
      const result = (await (await request("/v1/principals")).json()) as { items: { name: string }[] };
      return result.items.some((principal) => principal.name === "upgrade-first-write");
    },
  };
}
