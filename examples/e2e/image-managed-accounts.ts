import { randomUUID } from "node:crypto";
import { chmod } from "node:fs/promises";
import { probeImageAgentApi } from "./image-agentapi";
import { imageDisplayDiagnostics } from "./image-display-diagnostics";
import { probeKubernetesImageDisplay } from "./image-kubernetes-display";
import { createKubernetesCluster } from "./kubernetes-cluster";
import { command, freePort, waitFor } from "./local-process";
import { managerKubeconfig } from "./managed-account-kubeconfig";
import { assertManagedIsolation, runManagedEcho } from "./managed-account-probes";

// This fixture matches the image's kubectl 1.35 client and the planned 1.34 cell.
export const CANDIDATE_NODE_IMAGE =
  "kindest/node:v1.35.0@sha256:4613778f3cfcd10e615029370f5786704559103cf27bef934597ba562b269661";

export async function probeManagerImage(
  images: {
    manager: string;
    server: string;
    workspace: string;
    egress: string;
    desktop: string;
    browser: string;
  },
  configDigests: Record<string, string> = {},
) {
  const cluster = await createKubernetesCluster({ networkPolicy: true, nodeImage: CANDIDATE_NODE_IMAGE });
  const name = `${cluster.name}-manager`;
  const forwards: ReturnType<typeof Bun.spawn>[] = [];
  let created = false;
  let volume = false;
  try {
    const server = await cluster.loadImage(images.server, configDigests.server);
    const workspace = await cluster.loadImage(images.workspace, configDigests.workspace);
    const egress = await cluster.loadImage(images.egress, configDigests.egress);
    const kubeconfig = await managerKubeconfig(cluster, true);
    // The private host folder stays 0700; only this read-only manager mount sees the finite token.
    await chmod(kubeconfig, 0o444);
    await command(["docker", "volume", "create", name], { quiet: true });
    volume = true;
    const storage = ["--mount", `type=volume,src=${name},dst=/private`];
    const expiry = new Date(Date.now() + 30 * 60_000).toISOString();
    const operator = JSON.parse(
      (await command(["docker", "run", "--rm", ...storage, images.manager, "operator", expiry], { quiet: true }))
        .stdout,
    );
    const port = freePort();
    await command(
      [
        "docker",
        "run",
        "-d",
        "--name",
        name,
        "--network",
        "kind",
        "-p",
        `127.0.0.1:${port}:8092`,
        ...storage,
        "--mount",
        `type=bind,src=${kubeconfig},dst=/config/kubeconfig,readonly`,
        "-e",
        "KUBECONFIG=/config/kubeconfig",
        "-e",
        `POCKETCODER_MANAGER_CONTROLLER_IMAGE=${server.image}`,
        "-e",
        "POCKETCODER_MANAGER_RUNTIME_CLASS=pc-runc",
        images.manager,
      ],
      { quiet: true },
    );
    created = true;
    const url = `http://127.0.0.1:${port}`;
    const request = (path: string, options: RequestInit = {}) =>
      fetch(`${url}${path}`, {
        ...options,
        headers: { authorization: `Bearer ${operator.token}`, "content-type": "application/json", ...options.headers },
      });
    await waitFor(
      () =>
        request("/v1/accounts").then(
          (r) => r.ok,
          () => false,
        ),
      30_000,
      "candidate manager database and API",
    );
    const owners: { token: string; namespace: string; accountId: string; baseUrl: string }[] = [];
    const identities: string[] = [];
    for (const label of ["one", "two"]) {
      const id = randomUUID();
      const create = () =>
        request("/v1/accounts", {
          method: "POST",
          headers: { "idempotency-key": id },
          body: JSON.stringify({ name: label }),
        });
      const first = await create();
      if (!first.ok) throw new Error(`Image manager create refused: ${await first.text()}`);
      const row = (await first.json()) as { account: { id: string; namespace: string }; operation: { id: string } };
      const retry = (await (await create()).json()) as typeof row;
      if (row.account.id !== retry.account.id || row.operation.id !== retry.operation.id)
        throw new Error("Image manager duplicated account intent");
      await waitFor(
        async () => {
          const operation = (await (await request(`/v1/operations/${row.operation.id}`)).json()) as {
            state: string;
            errorCode?: string;
          };
          if (operation.state === "failed")
            throw new Error(`Image manager provisioning failed: ${operation.errorCode}`);
          return operation.state === "succeeded";
        },
        30_000,
        "candidate manager account controller",
      );
      const input = { request_id: randomUUID(), expires_at: new Date(Date.now() + 10 * 60_000).toISOString() };
      const claim = () =>
        request(`/v1/accounts/${row.account.id}/owner`, { method: "POST", body: JSON.stringify(input) });
      const issued = await claim();
      if (!issued.ok) throw new Error(`Image owner bootstrap refused: ${await issued.text()}`);
      const owner = (await issued.json()) as { token: string | null };
      if (!owner.token || ((await (await claim()).json()) as typeof owner).token !== null)
        throw new Error("Image owner plaintext return differs");
      const forwardPort = freePort();
      forwards.push(
        Bun.spawn(
          ["kubectl", "-n", row.account.namespace, "port-forward", "service/controller", `${forwardPort}:8090`],
          { env: { ...process.env, ...cluster.env }, stdout: "ignore", stderr: "ignore" },
        ),
      );
      const baseUrl = `http://127.0.0.1:${forwardPort}`;
      await waitFor(
        () =>
          fetch(`${baseUrl}/readyz`).then(
            (r) => r.ok,
            () => false,
          ),
        10_000,
        "candidate account forwarding",
      );
      owners.push({ token: owner.token, namespace: row.account.namespace, accountId: row.account.id, baseUrl });
      identities.push(row.account.id);
    }
    const manifest = await cluster.echoTemplate(workspace.image);
    manifest.spec.resources.ephemeralStorage = "128Mi";
    const echo = await runManagedEcho(owners[0] as (typeof owners)[number], manifest);
    await assertManagedIsolation(cluster, owners, echo.workspaceId);
    const owner = owners[0] as (typeof owners)[number];
    const agentapi = await probeImageAgentApi(owner.baseUrl, owner.token, workspace.image);
    const displays = [];
    const loaded = [server, workspace, egress];
    for (const mode of ["desktop", "browser"] as const) {
      const display = await cluster.loadImage(images[mode], configDigests[mode]);
      loaded.push(display);
      displays.push(
        await probeKubernetesImageDisplay(owner.baseUrl, owner.token, display.image, mode, (id) =>
          imageDisplayDiagnostics(cluster.kube, owner.namespace, id),
        ),
      );
    }
    console.log(
      await cluster.run(
        [process.execPath, "test", "packages/egress/src/proxy/kubernetes-conformance.test.ts"],
        undefined,
        { POCKETCODER_KUBERNETES_EGRESS_CONFORMANCE_IMAGE: egress.image },
      ),
    );
    let usage: { volume_bytes: number | null; coverage: { volume_samples: number } } | undefined;
    await waitFor(
      async () => {
        const response = await request(`/v1/accounts/${owner.accountId}/usage`);
        if (!response.ok) throw new Error(`Candidate usage read failed: ${await response.text()}`);
        usage = (await response.json()) as typeof usage;
        return Boolean(usage && (usage.volume_bytes ?? 0) > 0 && usage.coverage.volume_samples > 0);
      },
      30_000,
      "candidate manager physical volume observation",
    );
    await command(["docker", "restart", name], { quiet: true });
    await waitFor(
      async () => {
        const accounts = (await request("/v1/accounts").then(
          (r) => r.json(),
          () => null,
        )) as { items: { id: string }[] } | null;
        return (
          accounts?.items
            .map((a) => a.id)
            .sort()
            .join() === identities.sort().join()
        );
      },
      30_000,
      "manager durable inventory after restart",
    );
    return {
      result: "passed",
      nodeImage: CANDIDATE_NODE_IMAGE,
      accounts: identities,
      loadedImages: loaded,
      managerRestart: true,
      isolation: "finite owners; PVC, RBAC, quota and enforced Calico",
      agentapi,
      displays,
      usage,
    };
  } catch (error) {
    if (created) console.log(await command(["docker", "logs", name], { quiet: true }));
    console.log(await cluster.kube(["get", "pods", "-A", "-o", "wide"]).catch(() => ""));
    throw error;
  } finally {
    for (const forward of forwards) {
      forward.kill();
      await forward.exited;
    }
    if (created) await command(["docker", "rm", "--force", name], { quiet: true });
    if (volume) await command(["docker", "volume", "rm", name], { quiet: true });
    await cluster.close();
  }
}
