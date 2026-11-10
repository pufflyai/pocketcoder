import type { ExampleRequest } from "./session";
// This probes generic service routing; agent session checks use exampleSession instead.
export async function expectWorkspaceProbe(request: ExampleRequest, id: string, prompt: string) {
  const reply = await request(`/v1/workspaces/${id}/services/probe/probe`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: prompt }),
  });
  if (!reply.ok) throw new Error(`Workspace service probe failed (${reply.status})`);
  const body = (await reply.json()) as { echo: string };
  if (body.echo !== prompt) throw new Error("Workspace service probe response differs");
  return body.echo;
}
