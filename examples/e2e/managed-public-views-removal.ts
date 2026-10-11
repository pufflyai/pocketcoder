import type { createKubernetesCluster } from "./kubernetes-cluster";
import type { installEdge } from "./kubernetes-edge";
import { waitFor } from "./local-process";
import { accountRecords, closedWithin, type Owner, views } from "./managed-public-views-checks";

type Cluster = Awaited<ReturnType<typeof createKubernetesCluster>>;
type Edge = Awaited<ReturnType<typeof installEdge>>;

export async function removeAccount(
  cluster: Cluster,
  edge: Edge,
  options: { ca: string; one: Owner; two: Owner; workspaceId: string },
) {
  const { ca, one, two } = options;
  const session = views(ca, options.workspaceId);
  const stale = await session.open(one.client, false);
  const live = await session.connect(stale);
  await live.capture();
  // PC-94 owns full purge. Like it, drain work through the account before deleting
  // the namespace, which owns the hosts, certificate and sessions.
  await one.client.workspaces.cancel(options.workspaceId);
  await closedWithin(live.closed, "Drained account kept its view stream", 30_000);
  await waitFor(
    async () => (await one.client.workspaces.get(options.workspaceId)).state === "canceled",
    60_000,
    "account workspace drain",
  );
  await cluster.kube(["delete", "namespace", one.namespace, "--wait=false"]);
  await waitFor(
    () => cluster.kube(["get", "namespace", one.namespace, "--ignore-not-found", "-o", "name"]).then((name) => !name),
    180_000,
    "account namespace removal",
  );
  await cluster.kube(["delete", "clusterrolebinding,clusterrole", `${one.namespace}-nodes`, "--ignore-not-found"]);
  const leftovers = await cluster.kube([
    "get",
    "certificates,certificaterequests,ingresses,secrets",
    "-A",
    "-l",
    `pocketcoder.dev/account=${one.id}`,
    "-o",
    "name",
  ]);
  if (leftovers) throw new Error(`Removed account kept host resources: ${leftovers}`);
  await waitFor(
    async () => {
      const records = await edge.records();
      return accountRecords(records, one).length === 0 && accountRecords(records, two).length > 0;
    },
    60_000,
    "removed account DNS cleanup",
  );
  const staleSession = await fetch(`${stale.url.origin}/`, { headers: { cookie: stale.cookie }, tls: { ca } }).then(
    (response) => `status ${response.status}`,
    () => "no certificate",
  );
  if (staleSession.startsWith("status 2")) throw new Error("Removed account session still served");
  if (!(await fetch(`${two.api_origin}/readyz`, { tls: { ca } })).ok)
    throw new Error("Removal disturbed another account");
  return {
    stream: "closed by drain",
    resources: "none left",
    dns: "owned records removed",
    staleSession,
    otherAccount: "ready",
  };
}
