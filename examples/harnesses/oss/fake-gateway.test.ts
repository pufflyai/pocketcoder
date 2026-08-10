import { afterEach, describe, expect, test } from "bun:test";
import { OSS_FIXTURE_CONTENT, startFakeOssGateway } from "./fake-gateway";

let gateway: ReturnType<typeof Bun.serve> | undefined;

afterEach(() => {
  gateway?.stop(true);
  gateway = undefined;
});

function authorizedRequest(path: string, body: Record<string, unknown>): Request {
  return new Request(`http://127.0.0.1:${gateway?.port}${path}`, {
    method: "POST",
    headers: {
      authorization: "Bearer test-bearer",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("OSS harness E2E fake model gateway", () => {
  test("streams Responses API text for Codex", async () => {
    gateway = startFakeOssGateway("test-bearer", 1);
    const response = await fetch(
      authorizedRequest("/v1/responses", { model: "pocketcoder-test", stream: true }),
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(body.match(/event: response\.output_text\.delta/g)).toHaveLength(2);
    expect(body).toContain(OSS_FIXTURE_CONTENT.slice(0, 8));
    expect(body).toContain("event: response.completed");
  });

  test("streams Chat Completions text for OpenCode", async () => {
    gateway = startFakeOssGateway("test-bearer", 1);
    const response = await fetch(
      authorizedRequest("/v1/chat/completions", {
        model: "pocketcoder-test",
        stream: true,
        messages: [{ role: "user", content: "reply exactly" }],
      }),
    );
    const body = await response.text();
    const text = body
      .split("\n")
      .filter((line) => line.startsWith("data: {") && line.includes('"content"'))
      .map((line) => {
        const chunk = JSON.parse(line.slice(6)) as {
          choices: Array<{ delta: { content?: string } }>;
        };
        return chunk.choices[0]?.delta.content ?? "";
      })
      .join("");

    expect(response.status).toBe(200);
    expect(text).toBe(OSS_FIXTURE_CONTENT);
    expect(body.match(/"content":/g)).toHaveLength(2);
    expect(body).toEndWith("data: [DONE]\n\n");
  });

  test("rejects the wrong workspace bearer", async () => {
    gateway = startFakeOssGateway("test-bearer", 1);
    const response = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
      method: "POST",
      headers: { authorization: "Bearer wrong" },
      body: "{}",
    });

    expect(response.status).toBe(401);
  });
});
