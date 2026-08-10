import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runCli } from "./cli-test-support";

describe("pcd commands", () => {
  test("passes JSON launch input to restore and recreate", async () => {
    const requests: Array<{ path: string; body: unknown }> = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        requests.push({
          path: new URL(request.url).pathname,
          body: await request.json(),
        });
        return Response.json(
          {
            error: {
              code: "validation.invalid",
              message: "fixture response",
              request_id: "request-restore",
            },
          },
          { status: 400 },
        );
      },
    });
    const env = {
      POCKETCODER_URL: server.url.origin,
      POCKETCODER_KEY: "restore-key",
    };
    try {
      const restore = await runCli(
        [
          "workspaces",
          "restore",
          "--checkpoint",
          "checkpoint",
          "--external-id",
          "restored",
          "--input",
          '{"bootstrap_token":"restore-envelope"}',
        ],
        { env },
      );
      const recreate = await runCli(
        [
          "workspaces",
          "recreate",
          "--id",
          "workspace",
          "--external-id",
          "recreated",
          "--input",
          '{"bootstrap_token":"recreate-envelope"}',
        ],
        { env },
      );

      expect(restore.output).toContain("fixture response");
      expect(recreate.output).toContain("fixture response");
      expect(requests).toEqual([
        {
          path: "/v1/checkpoints/checkpoint/restore",
          body: {
            external_id: "restored",
            launch_input: { bootstrap_token: "restore-envelope" },
          },
        },
        {
          path: "/v1/workspaces/workspace/recreate",
          body: {
            external_id: "recreated",
            launch_input: { bootstrap_token: "recreate-envelope" },
          },
        },
      ]);
    } finally {
      await server.stop(true);
    }
  });

  test("validates a template through the yargs command tree", async () => {
    const template = resolve(import.meta.dir, "../../../examples/templates/fixture-echo.json");
    const result = await runCli(["templates", "validate", template]);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("fixture-echo@1.0.0");
    expect(result.output).toContain(": ok (");
  });

  test("renders JSON and YAML templates to the same canonical output", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pocketcoder-render-"));
    const jsonPath = join(directory, "template.json");
    const yamlPath = join(directory, "template.yaml");
    const jsonOut = join(directory, "json-out");
    const yamlOut = join(directory, "yaml-out");
    const image = `registry.test/agent@sha256:${"1".repeat(64)}`;
    const input = {
      apiVersion: "pocketcoder.dev/v1alpha1",
      kind: "Template",
      metadata: { name: "rendered", description: "fixture" },
      spec: {
        version: "1.0.0",
        image: `registry.test/agent@sha256:${"0".repeat(64)}`,
        agent: { type: "codex", command: ["codex"], env: { MODEL: "default" } },
        resources: { cpu: "1", memory: "1Gi" },
      },
    };
    writeFileSync(jsonPath, JSON.stringify(input, null, 2));
    writeFileSync(
      yamlPath,
      `apiVersion: pocketcoder.dev/v1alpha1
kind: Template
metadata:
  name: rendered
  description: fixture
spec:
  version: 1.0.0
  image: ${input.spec.image}
  agent:
    type: codex
    command: [codex]
    env:
      MODEL: default
  resources:
    cpu: "1"
    memory: 1Gi
`,
    );
    const originalJson = readFileSync(jsonPath, "utf8");
    try {
      for (const [source, out] of [
        [jsonPath, jsonOut],
        [yamlPath, yamlOut],
      ] as const) {
        const result = await runCli([
          "templates",
          "render",
          source,
          "--image",
          image,
          "--set",
          '/spec/agent/env/MODEL="gpt-5"',
          "--out",
          out,
        ]);
        expect(result.exitCode).toBe(0);
        expect(result.output).toContain("rendered@1.0.0-");
      }
      expect(readFileSync(join(jsonOut, "rendered.json"), "utf8")).toBe(
        readFileSync(join(yamlOut, "rendered.json"), "utf8"),
      );
      expect(readFileSync(jsonPath, "utf8")).toBe(originalJson);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
