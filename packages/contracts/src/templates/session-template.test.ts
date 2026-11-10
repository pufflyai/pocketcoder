import { expect, test } from "bun:test";
import { sessionTemplate } from "./session-template";
import { runtimeTemplateDefinition } from "./workload-policy";

test("native session templates install a qualified execution service", () => {
  const template = sessionTemplate({
    name: "echo",
    version: "2.0.0",
    image: `example/echo@sha256:${"a".repeat(64)}`,
    runtimeDigest: `sha256:${"b".repeat(64)}`,
    producer: {
      digest: `sha256:${"b".repeat(64)}`,
      command: ["/usr/local/bin/bun", "/opt/pocketcoder/supervisor.js", "session", "serve", "echo"],
    },
  });
  const parsed = runtimeTemplateDefinition(template);
  expect(parsed.workload?.spec.operations.message?.inputSchema.properties).toEqual({ message: { type: "string" } });
  expect(parsed.workload?.spec.services.session?.process?.command).toEqual([
    "/usr/local/bin/bun",
    "/opt/pocketcoder/supervisor.js",
    "session",
    "serve",
    "echo",
  ]);
  expect(parsed.workload?.spec.services.session?.routes.map((route) => route.path)).toEqual([
    "/executions/accept",
    "/executions/lookup",
    "/executions/cancel",
    "/executions/ack",
  ]);
});

test("native workload policies preserve a controller-owned registry secret reference", () => {
  const template = sessionTemplate({
    name: "private",
    version: "1.0.0",
    image: `example/private@sha256:${"a".repeat(64)}`,
    runtimeDigest: `sha256:${"b".repeat(64)}`,
    producer: {
      digest: `sha256:${"b".repeat(64)}`,
      command: ["/usr/local/bin/bun", "/opt/pocketcoder/supervisor.js", "session", "serve", "echo"],
    },
  });
  template.spec.imagePullSecret = "secretRef:private-registry";
  expect(runtimeTemplateDefinition(template).policy.imagePullSecret).toBe("secretRef:private-registry");
});
