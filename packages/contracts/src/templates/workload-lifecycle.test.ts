import { expect, test } from "bun:test";
import { waitingExecSpec } from "../protocol/waiting-exec";
import { workloadFixture } from "./workload-fixtures.test";
import { parseWorkloadTemplate, workloadSnapshotOf } from "./workload-template";

test("service startup retains declared mounts, checkpoint hook and bounded launch input", () => {
  const source = workloadFixture();
  const input = { chat_id: "chat-a", bootstrap_code: "one-time-test-code" };
  const lifecycle = {
    persistence: {
      mounts: [
        { name: "home", target: "/home/worker", maxBytes: 1048576, maxFiles: 100 },
        { name: "state", target: "/var/worker/state", maxBytes: 1048576, maxFiles: 100 },
      ],
      conversationRestore: "supported",
      sessionCompatibility: "worker-test/v1",
    },
    checkpointHook: { command: ["python3", "/opt/worker/chat_runtime.py", "quiesce"], timeoutSeconds: 20 },
  };
  const snapshot = workloadSnapshotOf(parseWorkloadTemplate({ ...source, spec: { ...source.spec, lifecycle } }));
  const exec = waitingExecSpec(snapshot, "observed-incarnation", "restore", input);
  expect(exec.harness).toBeNull();
  expect(exec.persistence.mounts).toEqual(lifecycle.persistence.mounts.map(({ name, target }) => ({ name, target })));
  expect(exec.persistence.conversation_restore).toBe("supported");
  expect(exec.checkpoint_hook?.command).toEqual(lifecycle.checkpointHook.command);
  expect(exec.env.POCKETCODER_LAUNCH_INPUT).toBe(JSON.stringify(input));
});

test("canonical state mounts cannot expose immutable inputs or alias each other", () => {
  const source = workloadFixture();
  const lifecycle = {
    persistence: { mounts: [{ name: "input-alias", target: "/run/pocketcoder/inputs", maxBytes: 1024, maxFiles: 10 }] },
  };
  expect(() => parseWorkloadTemplate({ ...source, spec: { ...source.spec, lifecycle } })).toThrow();
});

test("canonical checkpoint hooks cannot carry standing credentials or unnormalized paths", () => {
  const manifest = workloadFixture();
  for (const checkpointHook of [
    { command: ["/bin/true"], env: { API_TOKEN: "standing-secret" } },
    { command: ["/bin/true"], cwd: "/tmp/../home" },
  ])
    expect(() =>
      parseWorkloadTemplate({ ...manifest, spec: { ...manifest.spec, lifecycle: { checkpointHook } } }),
    ).toThrow();
});
