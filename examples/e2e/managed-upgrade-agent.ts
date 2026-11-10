import { expectWorkspaceProbe } from "./workspace-probe";
export async function upgradeAgentTurn(
  request: (path: string, input?: RequestInit) => Promise<Response>,
  workspaceId: string,
  prompt: string,
) {
  const started = Date.now();
  const responseText = await expectWorkspaceProbe(request, workspaceId, prompt);
  return { workspaceId, responseText, responseInMs: Date.now() - started };
}
