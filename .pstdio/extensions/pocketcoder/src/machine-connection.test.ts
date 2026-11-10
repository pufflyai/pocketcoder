import { expect, test } from "bun:test";
import { machineConnection } from "./machine-connection";

test("AgentAPI is the default, but relay machines require a device and workspace", () => {
  expect(machineConnection({})).toEqual({ kind: "agentapi" });
  expect(() => machineConnection({ "pstdio.connection": "relay" })).toThrow("device and workspace");
  expect(
    machineConnection({ "pstdio.connection": "relay", "pstdio.device_id": "guest", "pstdio.workspace_id": "ws" }),
  ).toEqual({ kind: "relay", deviceId: "guest", workspaceId: "ws" });
});

test("a relay binding never falls back to the AgentAPI harness", () => {
  expect(() => machineConnection({ "pstdio.connection": "relay", "pstdio.device_id": "guest" })).toThrow("relay");
  expect(() => machineConnection({ "pstdio.connection": "unknown" })).toThrow("Unknown");
});
