import { PocketCoderClient } from "@pstdio/pocketcoder-sdk";
import { imageSessionTemplate } from "../local/session-template";
import { createHarnessWorkspace } from "./contract";
import { fetchForwarded } from "./forwarded-fetch";
import { expectEcho } from "./session";
export async function probeImageSession(baseUrl: string, key: string, image: string) {
  const client = new PocketCoderClient({ baseUrl, apiKey: key, fetch: fetchForwarded });
  await client.templates.publish(await imageSessionTemplate(image, "candidate-session"));
  const workspace = await createHarnessWorkspace({ baseUrl, key, template: "candidate-session" });
  try {
    await expectEcho(workspace.request, workspace.workspaceId, `candidate-api-${crypto.randomUUID()}`);
    return { image, callback: "authenticated supervisor", transport: "structured session", result: "passed" };
  } finally {
    await workspace.cancel();
  }
}
