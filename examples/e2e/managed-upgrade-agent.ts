import { messageList, responseText } from "./contract-messages";
import { waitFor } from "./local-process";

export async function upgradeAgentTurn(
  request: (path: string, input?: RequestInit) => Promise<Response>,
  workspaceId: string,
  prompt: string,
) {
  await waitFor(
    async () => (await (await request(`/v1/workspaces/${workspaceId}/agent/status`)).json()).status === "stable",
    30_000,
    "upgrade agent readiness",
  );
  const started = Date.now();
  const sent = await request(`/v1/workspaces/${workspaceId}/agent/message`, {
    method: "POST",
    body: JSON.stringify({ content: prompt, type: "user" }),
  });
  if (!sent.ok) throw new Error(`Upgrade agent turn failed: ${sent.status}`);
  let observed = "";
  await waitFor(
    async () => {
      const messages = await request(`/v1/workspaces/${workspaceId}/agent/messages`);
      if (!messages.ok) return false;
      observed = responseText(messageList(await messages.json()), 0);
      return observed.includes(`echo: ${prompt}`);
    },
    30_000,
    "upgrade agent response",
  );
  return { workspaceId, responseText: observed, responseInMs: Date.now() - started };
}
