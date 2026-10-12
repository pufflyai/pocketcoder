import { randomUUID } from "node:crypto";
import { createHarnessWorkspace } from "./contract";
import type { managedLifecycleFixture } from "./managed-lifecycle-fixture";
import { upgradeAgentTurn } from "./managed-upgrade-agent";

export async function upgradeObserver(
  fixture: Awaited<ReturnType<typeof managedLifecycleFixture>>,
  account: { id: string; namespace: string },
) {
  const response = await fixture.request(`/v1/accounts/${account.id}/owner`, {
    method: "POST",
    body: JSON.stringify({ request_id: randomUUID(), expires_at: new Date(Date.now() + 25 * 60_000).toISOString() }),
  });
  const owner = (await response.json()) as { token: string };
  if (!response.ok || !owner.token) throw new Error("Observer owner issuance failed.");
  let url = await fixture.connect(account.namespace);
  const request = (path: string, input: RequestInit = {}) =>
    fetch(`${url}${path}`, {
      ...input,
      headers: { authorization: `Bearer ${owner.token}`, "content-type": "application/json", ...input.headers },
    });
  const template = await fixture.cluster.echoTemplate(fixture.workspace.image);
  template.spec.resources.ephemeralStorage = "128Mi";
  const imported = await request("/v1/templates", {
    method: "POST",
    body: JSON.stringify({ manifest: template }),
  });
  if (!imported.ok) throw new Error("Observer template import failed.");
  const workspace = await createHarnessWorkspace({ baseUrl: url, key: owner.token, template: template.metadata.name });
  const kube = fixture.cluster.kube;
  async function pods() {
    const current = JSON.parse(await kube(["-n", account.namespace, "get", "pods", "-o", "json"])).items;
    const controller = current.find(
      (pod: { metadata: { labels: Record<string, string> } }) =>
        pod.metadata.labels["pocketcoder.dev/role"] === "controller",
    );
    const agent = current.find(
      (pod: { metadata: { labels: Record<string, string> } }) =>
        pod.metadata.labels["pocketcoder.workspace"] === workspace.workspaceId,
    );
    if (!controller || !agent) throw new Error("Observer compute is missing.");
    return {
      controller: controller.metadata.uid as string,
      agent: agent.metadata.uid as string,
      name: agent.metadata.name as string,
    };
  }
  const original = await pods();
  return async () => {
    if (JSON.stringify(await pods()) !== JSON.stringify(original))
      throw new Error("Another account's controller or workspace was replaced during upgrade.");
    url = await fixture.connect(account.namespace);
    // Real agent traffic keeps the observer active under the template's idle limit.
    await upgradeAgentTurn(request, workspace.workspaceId, `other-account-progress-${randomUUID()}`);
    console.log(
      JSON.stringify({
        otherAccountRunning: {
          account: account.id,
          workspace: workspace.workspaceId,
          podUid: original.agent,
          controllerUid: original.controller,
          agentResponse: true,
        },
      }),
    );
  };
}
