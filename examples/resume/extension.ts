import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRemoteExtension } from "@pstdio/pocketcoder-remote/extension";
import { PocketCoderClient, WorkspaceTurnResolver } from "@pstdio/pocketcoder-sdk";

import { requiredEnvironment } from "./environment";

const client = new PocketCoderClient({
  baseUrl: requiredEnvironment("POCKETCODER_URL"),
  apiKey: requiredEnvironment("POCKETCODER_KEY"),
});

async function control(
  action: string,
  workspaceId: string,
  attemptId?: string,
  signal?: AbortSignal,
) {
  const response = await fetch(`${process.env.POCKETCODER_RESUME_CONTROL_URL}/${action}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.POCKETCODER_RESUME_CONTROL_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ workspaceId, attemptId }),
    signal,
  });
  if (!response.ok) throw new Error(await response.text());
  return response;
}

let currentId = requiredEnvironment("POCKETCODER_WORKSPACE_ID");
const resolver = new WorkspaceTurnResolver({
  client,
  resumeWorkspace: async ({ source, attemptId, signal }) => {
    const response = await control("resume", source.id, attemptId, signal);
    const body = (await response.json()) as { id: string };
    const workspace = await client.workspaces.get(body.id, { signal });
    currentId = workspace.id;
    return workspace;
  },
});

export default function (pi: ExtensionAPI) {
  createRemoteExtension({ resolver })(pi);
  // RPC clients also need the same quit command as the interactive terminal.
  if (process.env.POCKETCODER_RESUME_RPC === "1") {
    pi.registerCommand("quit", {
      description: "Disconnect and preserve this isolated session.",
      handler: async (_args, context) => context.shutdown(),
    });
  }
  pi.registerCommand("preserve", {
    description: "Preserve this workspace. The next message resumes it.",
    handler: async (_args, context) => {
      await control("preserve", currentId);
      context.ui.notify(
        "Preservation requested. Your next message will resume the workspace.",
        "info",
      );
    },
  });
}
