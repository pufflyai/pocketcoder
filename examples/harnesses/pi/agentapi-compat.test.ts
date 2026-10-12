import { expect, test } from "bun:test";
import { createHarnessWorkspace } from "../../e2e/contract";
import { waitFor } from "../../e2e/local-process";
import { PI_FIXTURE_CONTENT } from "./fake-gateway";

const baseUrl = process.env.POCKETCODER_PI_TEST_URL ?? "";
const key = process.env.POCKETCODER_PI_TEST_KEY ?? "";

test.skipIf(!baseUrl || !key)(
  "Pi keeps repeated file replies in AgentAPI and durable history",
  async () => {
    const workspace = await createHarnessWorkspace({
      baseUrl,
      key,
      template: "pi-harness",
      readyTimeoutMs: 300_000,
    });
    const agent = `/v1/workspaces/${workspace.workspaceId}/agent`;
    const prompt =
      "Read /workspace/test.txt with the read tool. Reply with exactly the file contents and nothing else.";
    const status = async () => {
      const body = (await (await workspace.request(`${agent}/status`)).json()) as { status: string };
      return body.status;
    };
    const messages = async () => {
      const body = (await (await workspace.request(`${agent}/messages`)).json()) as {
        messages: Array<{ id: number; role: string; content: string }>;
      };
      return body.messages;
    };
    try {
      await waitFor(async () => (await status()) === "stable", 120_000, "Pi input");
      for (let turn = 0; turn < 4; turn += 1) {
        const baseline = (await messages()).at(-1)?.id ?? -1;
        const sent = await workspace.request(`${agent}/message`, {
          method: "POST",
          body: JSON.stringify({ type: "user", content: prompt }),
        });
        expect(sent.ok).toBe(true);
        let reply = "";
        await waitFor(
          async () => {
            const last = (await messages()).at(-1);
            if (last && last.id > baseline && last.role === "agent" && (await status()) === "stable") {
              reply = last.content;
              return true;
            }
            return false;
          },
          60_000,
          "stable repeated reply",
        );
        expect(reply).toContain(PI_FIXTURE_CONTENT);
      }
      await waitFor(
        async () => {
          const response = await workspace.request(`/v1/workspaces/${workspace.workspaceId}/conversation`);
          const body = (await response.json()) as { items: Array<{ role: string; content: string }> };
          return (
            body.items.filter((message) => message.role === "assistant" && message.content.includes(PI_FIXTURE_CONTENT))
              .length === 4
          );
        },
        30_000,
        "four durable file replies",
      );
    } finally {
      await workspace.cancel();
    }
  },
  180_000,
);
