import { expect, test } from "bun:test";
import { createHarnessWorkspace } from "../../e2e/contract";
import { exampleSession } from "../../e2e/session";
import { PI_FIXTURE_CONTENT } from "./fake-gateway";

const baseUrl = process.env.POCKETCODER_PI_TEST_URL ?? "";
const key = process.env.POCKETCODER_PI_TEST_KEY ?? "";
test.skipIf(!baseUrl || !key)(
  "native Pi retains four identical replies with distinct message IDs",
  async () => {
    const workspace = await createHarnessWorkspace({ baseUrl, key, template: "pi-harness", readyTimeoutMs: 300_000 });
    const session = exampleSession(workspace.request, workspace.workspaceId);
    try {
      for (let turn = 0; turn < 4; turn++)
        await session.sendAndWait(
          "Read /workspace/test.txt with the read tool. Reply with exactly the file contents and nothing else.",
        );
      const replies = (await session.messages()).filter((m) => m.identity?.fact?.type === "final_response");
      expect(replies).toHaveLength(4);
      expect(new Set(replies.map((m) => m.message_id)).size).toBe(4);
      for (const reply of replies) expect(reply.content).toContain(PI_FIXTURE_CONTENT);
    } finally {
      await workspace.cancel();
    }
  },
  300_000,
);
