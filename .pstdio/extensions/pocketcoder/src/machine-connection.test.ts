import { expect, test } from "bun:test";
import { PocketCoderHttpError } from "./instances";
import { machineConnection } from "./machine-connection";

const relayMetadata = { "pstdio.device_id": "guest", "pstdio.workspace_id": "ws" };
const sessionTemplate = async () => ({ requests: true });
const relayTemplate = async () => {
  throw new PocketCoderHttpError(422, "relay.route_not_allowed", "No session route.");
};

test("the machine's template decides the connection, not a launch choice", async () => {
  expect(await machineConnection(sessionTemplate, relayMetadata)).toEqual({ kind: "session" });
  expect(await machineConnection(relayTemplate, relayMetadata)).toEqual({
    kind: "relay",
    deviceId: "guest",
    workspaceId: "ws",
  });
});

test("a relay template needs the machine's enrolled device and workspace", async () => {
  await expect(machineConnection(relayTemplate, {})).rejects.toThrow("device and workspace");
  await expect(machineConnection(relayTemplate, { "pstdio.device_id": "guest" })).rejects.toThrow(
    "device and workspace",
  );
});

test("other controller failures are not mistaken for a relay template", async () => {
  const unavailable = async () => {
    throw new PocketCoderHttpError(503, "workspace.unavailable", "Not ready.");
  };
  await expect(machineConnection(unavailable, relayMetadata)).rejects.toThrow("workspace.unavailable");
  await expect(machineConnection(async () => ({ requests: false }), relayMetadata)).rejects.toThrow(
    "native PocketCoder session",
  );
});
