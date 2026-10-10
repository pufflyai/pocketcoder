import { randomUUID } from "node:crypto";
import { createHarnessWorkspace } from "./contract";
import { messageList, responseText } from "./contract-messages";
import type { createKubernetesCluster } from "./kubernetes-cluster";
import { waitFor } from "./local-process";

type Owner = { token: string; namespace: string; accountId: string; baseUrl: string };
const request = (owner: Owner, path: string, options: RequestInit = {}) =>
  fetch(`${owner.baseUrl}${path}`, {
    ...options,
    headers: { authorization: `Bearer ${owner.token}`, "content-type": "application/json", ...options.headers },
  });
export async function runManagedEcho(owner: Owner, manifest: unknown) {
  const imported = await request(owner, "/v1/templates", { method: "POST", body: JSON.stringify({ manifest }) });
  if (!imported.ok) throw new Error(`Managed template refused: ${await imported.text()}`);
  const workspace = await createHarnessWorkspace({
    baseUrl: owner.baseUrl,
    key: owner.token,
    template: "echo-harness",
  });
  const prompt = `managed ${randomUUID()}`;
  const sent = await request(owner, `/v1/workspaces/${workspace.workspaceId}/agent/message`, {
    method: "POST",
    body: JSON.stringify({ type: "user", content: prompt }),
  });
  if (!sent.ok) throw new Error("Managed agent message refused");
  await waitFor(
    async () =>
      responseText(
        messageList(await (await request(owner, `/v1/workspaces/${workspace.workspaceId}/agent/messages`)).json()),
        0,
      ) === `echo: ${prompt}`,
    30_000,
    "managed echo agent",
  );
  return workspace;
}
export async function assertManagedIsolation(
  cluster: Awaited<ReturnType<typeof createKubernetesCluster>>,
  owners: Owner[],
  workspaceId: string,
) {
  const [one, two] = owners;
  if (!one || !two) throw new Error("Two managed accounts required");
  if (
    (await fetch(`${two.baseUrl}/v1/templates`, { headers: { authorization: `Bearer ${one.token}` } })).status !== 401
  )
    throw new Error("Owner key crossed accounts");
  if ((await request(two, `/v1/workspaces/${workspaceId}`)).status !== 404)
    throw new Error("Workspace crossed account boundary");
  const list = JSON.parse(
    await cluster.kube([
      "-n",
      one.namespace,
      "get",
      "pods",
      "-l",
      `pocketcoder.workspace=${workspaceId}`,
      "-o",
      "json",
    ]),
  );
  const pod = list.items[0];
  if (
    pod.spec.automountServiceAccountToken !== false ||
    pod.spec.volumes.some((v: Record<string, unknown>) => v.persistentVolumeClaim || v.hostPath)
  )
    throw new Error("Workspace can read standing credentials or private controller storage");
  const probe = `await fetch('http://controller.${one.namespace}.svc:8091/readyz',{signal:AbortSignal.timeout(1000)});const urls=['http://controller.${two.namespace}.svc:8090/readyz','http://controller.${two.namespace}.svc:8091/readyz','http://controller.${one.namespace}.svc:8090/readyz'];for(const url of urls){let allowed=false;try{await fetch(url,{signal:AbortSignal.timeout(1000)});allowed=true}catch{}if(allowed)throw new Error('Private controller network access allowed')}console.log('AgentAPI reachable; cross-account and own operator network access denied')`;
  console.log(await cluster.kube(["-n", one.namespace, "exec", pod.metadata.name, "--", "bun", "-e", probe]));
  for (const owner of owners) {
    const other = owner === one ? two : one;
    const denied = Bun.spawn(
      [
        "kubectl",
        "auth",
        "can-i",
        "get",
        "secrets",
        "-n",
        other.namespace,
        `--as=system:serviceaccount:${owner.namespace}:controller`,
      ],
      { env: { ...process.env }, stdout: "pipe", stderr: "pipe" },
    );
    const [decision, code] = await Promise.all([
      new Response(denied.stdout).text(),
      denied.exited,
      new Response(denied.stderr).text(),
    ]);
    if (code !== 1 || decision.trim() !== "no") throw new Error("Controller RBAC denial not proven");
    const quota = JSON.parse(
      await cluster.kube(["-n", owner.namespace, "get", "resourcequota", "account", "-o", "json"]),
    );
    if (quota.spec.hard.persistentvolumeclaims !== "1" || quota.spec.hard["requests.storage"] !== "10Gi")
      throw new Error("Account storage quota differs");
    const pvc = JSON.parse(await cluster.kube(["-n", owner.namespace, "get", "pvc", "controller-data", "-o", "json"]));
    if (pvc.status.phase !== "Bound" || pvc.spec.accessModes.join() !== "ReadWriteOnce")
      throw new Error("Private controller volume not bound");
  }
  await request(one, `/v1/workspaces/${workspaceId}/cancel`, { method: "POST", body: "{}" });
  await waitFor(
    async () =>
      ((await (await request(one, `/v1/workspaces/${workspaceId}`)).json()) as { state: string }).state === "canceled",
    30_000,
    "managed workspace cleanup",
  );
}
