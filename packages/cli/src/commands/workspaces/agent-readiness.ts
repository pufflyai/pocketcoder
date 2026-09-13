export type ApiRequest = (path: string, init?: RequestInit) => Promise<Response>;
export type CliFail = (message: string) => never;

export interface WorkspaceChatDeps {
  api: ApiRequest;
  fail: CliFail;
}

export async function readWorkspaceAgentState(
  id: string,
  { api, fail }: WorkspaceChatDeps,
): Promise<string> {
  const response = await api(`/v1/workspaces/${id}`);
  const body = (await response.json()) as { state?: unknown; agent_state?: unknown };
  if (!response.ok) {
    fail(`workspace lookup failed (${response.status}): ${JSON.stringify(body)}`);
  }
  if (body.state !== "ready") {
    fail(`workspace is ${String(body.state ?? "unavailable")}; it is not live`);
  }
  if (
    body.agent_state !== "unknown" &&
    body.agent_state !== "running" &&
    body.agent_state !== "stable"
  ) {
    fail(`workspace returned unknown agent state: ${JSON.stringify(body.agent_state)}`);
  }
  return typeof body.agent_state === "string" ? body.agent_state : "unknown";
}

// A workspace turns ready when its services answer health checks, which can
// happen while AgentAPI is still starting. It rejects a user message until it
// is waiting for input, so wait for that before sending.
export async function waitForAgentInput(
  id: string,
  options: { timeoutSeconds: number; pollIntervalMs: number },
  deps: WorkspaceChatDeps,
): Promise<void> {
  const deadline = Date.now() + options.timeoutSeconds * 1000;
  while ((await readWorkspaceAgentState(id, deps)) !== "stable") {
    if (Date.now() >= deadline) {
      deps.fail(`agent was not ready for input within ${options.timeoutSeconds} seconds`);
    }
    await Bun.sleep(options.pollIntervalMs);
  }
}
