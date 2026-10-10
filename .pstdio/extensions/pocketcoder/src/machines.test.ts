import { expect, test } from "bun:test";
import { machineRef, projectMachine } from "./machines";

test("keeps the instance in every remote execution target and exposes real capabilities", () => {
  const result = projectMachine("pocketcoder.pocketcoder", "instance-1", {
    id: "machine-1",
    state: "ready",
    change_cursor: 1,
    agent_state: "stable",
    reason_code: null,
    failure: null,
  });
  expect(result.providerRef).toEqual({ version: 1, data: { instanceId: "instance-1", machineId: "machine-1" } });
  expect(result.executionTarget).toEqual({
    kind: "remote",
    providerId: "pocketcoder.pocketcoder.workspace-type.machine",
    providerRef: result.providerRef,
  });
  expect(result.capabilities).toEqual({
    files: "none",
    diff: false,
    merge: false,
    rebase: false,
    archive: false,
    delete: true,
  });
});

test.each([
  ["queued", "provisioning"],
  ["provisioning", "provisioning"],
  ["connected", "provisioning"],
  ["ready", "ready"],
  ["terminating", "deleting"],
  ["preserving", "provisioning"],
  ["preserved", "archived"],
  ["canceled", "cancelled"],
  ["expired", "failed"],
  ["failed", "failed"],
  ["succeeded", "archived"],
] as const)("maps %s to %s", (state, expected) => {
  expect(
    projectMachine("extension", "instance", {
      id: "id",
      state,
      change_cursor: 1,
      agent_state: "stable",
      reason_code: null,
      failure: null,
    }).state,
  ).toBe(expected);
});

test("rejects incomplete and unknown provider references", () => {
  expect(() => machineRef({ version: 1, data: { machineId: "machine" } })).toThrow("reference");
  expect(() => machineRef({ version: 2, data: { instanceId: "instance", machineId: "machine" } })).toThrow("reference");
});
