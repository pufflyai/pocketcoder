import { expect, test } from "bun:test";
import { machineStateLabel, unavailableMachineMessage } from "./machine-status";
import type { Machine } from "./machines";

const machine = (state: Machine["state"], reason: string | null = null) => ({ state, reason_code: reason });

test("connected still means the agent is starting, and ready is the connectable state", () => {
  expect(machineStateLabel("connected")).toBe("Starting agent");
  expect(machineStateLabel("provisioning")).toBe("Starting machine");
  expect(machineStateLabel("ready")).toBe("Ready");
  expect(unavailableMachineMessage(machine("connected"))).toContain("starting");
  expect(unavailableMachineMessage(machine("ready"))).toBeUndefined();
});

test("failed and expired machines tell the user to recover instead of waiting", () => {
  const failure = unavailableMachineMessage(machine("failed", "launch_refused"));
  expect(failure).toContain("failed");
  expect(failure).toContain("launch_refused");
  expect(failure).toContain("Relaunch machine");
  expect(failure).not.toContain("Wait");
  expect(unavailableMachineMessage(machine("expired", "idle_expired"))).not.toContain("Wait");
  expect(unavailableMachineMessage(machine("preserved"))).toContain("Resume machine");
});
