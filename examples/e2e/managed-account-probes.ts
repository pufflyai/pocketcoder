import { randomUUID } from "node:crypto";
import { createHarnessWorkspace } from "./contract";
import { messageList, responseText } from "./contract-messages";
import { fetchForwarded } from "./forwarded-fetch";
import type { createKubernetesCluster } from "./kubernetes-cluster";
import { waitFor } from "./local-process";

type Owner = { token: string; namespace: string; accountId: string; baseUrl: string };
export const requestManagedAccount = (owner: Owner, path: string, options: RequestInit = {}) =>
  fetchForwarded(`${owner.baseUrl}${path}`, {
    ...options,
    headers: { authorization: `Bearer ${owner.token}`, "content-type": "application/json", ...options.headers },
  });
// Policy drops show up as timeouts. Any other failure (refused, TLS, HTTP) means the
// packet got through, so only a timeout after a successful DNS lookup counts as denial.
function reachability(reach: string[], deny: string[]) {
  return `const{lookup}=await import('node:dns/promises');const reached=async(url)=>{try{await fetch(url,{signal:AbortSignal.timeout(3000),tls:{rejectUnauthorized:false}});return true}catch(error){return error.name!=='TimeoutError'}};for(const url of ${JSON.stringify(reach)})if(!(await reached(url)))throw new Error('Expected access: '+url);for(const url of ${JSON.stringify(deny)}){await lookup(new URL(url).hostname);if(await reached(url))throw new Error('Network access allowed: '+url)}console.log('${reach.length} reached; ${deny.length} denied by policy timeout')`;
}
export async function runManagedEcho(owner: Owner, manifest: unknown) {
  const imported = await requestManagedAccount(owner, "/v1/templates", {
    method: "POST",
    body: JSON.stringify({ manifest }),
  });
  if (!imported.ok) throw new Error(`Managed template refused: ${await imported.text()}`);
  const workspace = await createHarnessWorkspace({
    baseUrl: owner.baseUrl,
    key: owner.token,
    template: "echo-harness",
  });
  const prompt = `managed ${randomUUID()}`;
  const sent = await requestManagedAccount(owner, `/v1/workspaces/${workspace.workspaceId}/agent/message`, {
    method: "POST",
    body: JSON.stringify({ type: "user", content: prompt }),
  });
  if (!sent.ok) throw new Error("Managed agent message refused");
  await waitFor(
    async () =>
      responseText(
        messageList(
          await (await requestManagedAccount(owner, `/v1/workspaces/${workspace.workspaceId}/agent/messages`)).json(),
        ),
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
  if ((await requestManagedAccount(two, `/v1/workspaces/${workspaceId}`)).status !== 404)
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
  const workspaceProbe = reachability(
    [`http://controller.${one.namespace}.svc:8091/readyz`],
    [
      `http://controller.${two.namespace}.svc:8090/readyz`,
      `http://controller.${two.namespace}.svc:8091/readyz`,
      `http://controller.${one.namespace}.svc:8090/readyz`,
      "https://kubernetes.default.svc/version",
    ],
  );
  console.log(await cluster.kube(["-n", one.namespace, "exec", pod.metadata.name, "--", "bun", "-e", workspaceProbe]));
  const controller = JSON.parse(
    await cluster.kube(["-n", one.namespace, "get", "pods", "-l", "pocketcoder.dev/role=controller", "-o", "json"]),
  ).items[0];
  const controllerProbe = reachability(
    ["https://kubernetes.default.svc/version"],
    [`http://controller.${two.namespace}.svc:8090/readyz`, `https://${controller.status.hostIP}:10250/healthz`],
  );
  console.log(
    await cluster.kube([
      "-n",
      one.namespace,
      "exec",
      controller.metadata.name,
      "-c",
      "controller",
      "--",
      "bun",
      "-e",
      controllerProbe,
    ]),
  );
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
      { env: { ...process.env, ...cluster.env }, stdout: "pipe", stderr: "pipe" },
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
  await requestManagedAccount(one, `/v1/workspaces/${workspaceId}/cancel`, { method: "POST", body: "{}" });
  await waitFor(
    async () =>
      ((await (await requestManagedAccount(one, `/v1/workspaces/${workspaceId}`)).json()) as { state: string })
        .state === "canceled",
    30_000,
    "managed workspace cleanup",
  );
}
