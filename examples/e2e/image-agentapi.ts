import { randomUUID } from "node:crypto";
import { PocketCoderClient } from "@pstdio/pocketcoder-sdk";
import { createHarnessWorkspace } from "./contract";
import { waitFor } from "./local-process";

const fixture =
  "process.stdout.write('Ready\\n> ');for await(const line of console){process.stdout.write('\\nEcho: '+line+'\\n> ')}";

export async function probeImageAgentApi(baseUrl: string, key: string, image: string) {
  const client = new PocketCoderClient({ baseUrl, apiKey: key });
  await client.raw("/v1/templates", {
    method: "POST",
    body: JSON.stringify({
      manifest: {
        apiVersion: "pocketcoder.dev/v1alpha1",
        kind: "Template",
        metadata: { name: "candidate-agentapi" },
        spec: {
          version: "1.0.0",
          image,
          agent: { type: "custom", command: ["bun", "-e", fixture], cwd: "/tmp" },
          resources: { cpu: "1", memory: "512Mi" },
          security: { uid: 10001, gid: 10001, readOnlyRoot: true, writableMemoryPaths: ["/tmp"] },
          timeouts: { start: "30s", terminateGrace: "3s" },
        },
      },
    }),
  });
  const workspace = await createHarnessWorkspace({ baseUrl, key, template: "candidate-agentapi" });
  let observed = "";
  try {
    const prompt = `candidate-api-${randomUUID()}`;
    await client.agent.sendMessage(workspace.workspaceId, { content: prompt });
    await waitFor(
      async () => {
        observed = JSON.stringify(
          await (await client.raw(`/v1/workspaces/${workspace.workspaceId}/agent/messages`)).json(),
        );
        return observed.includes(prompt) && observed.includes("Echo:");
      },
      30_000,
      "real candidate AgentAPI request and response",
    );
    return { image, callback: "authenticated supervisor", transport: "native AgentAPI", result: "passed" };
  } catch (error) {
    console.log(`Candidate AgentAPI messages: ${observed}`);
    throw error;
  } finally {
    await workspace.cancel();
  }
}
