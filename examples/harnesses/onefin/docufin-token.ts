#!/usr/bin/env bun
import { createConnection } from "node:net";

const path = process.env.ONEFIN_AGENT_TOKEN_SOCKET;
if (!path) throw new Error("Onefin token socket is not configured");
const socket = createConnection(path);
socket.setTimeout(15_000, () => socket.destroy(new Error("Onefin token socket timed out")));
socket.on("data", (data) => process.stdout.write(data));
socket.on("error", () => {
  process.exitCode = 1;
});
