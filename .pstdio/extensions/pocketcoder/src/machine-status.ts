import { isTerminal, type Machine } from "./machines";

const labels: Record<Machine["state"], string> = {
  queued: "Queued",
  provisioning: "Starting machine",
  connected: "Starting agent",
  ready: "Ready",
  preserving: "Saving checkpoint",
  terminating: "Stopping",
  succeeded: "Completed",
  failed: "Failed",
  canceled: "Canceled",
  expired: "Expired",
  preserved: "Preserved",
};
export const machineStateLabel = (state: Machine["state"]) => labels[state];

export function unavailableMachineMessage(machine: Pick<Machine, "state" | "reason_code">) {
  if (machine.state === "ready") return undefined;
  if (machine.state === "preserved")
    return "Machine is preserved. Use Resume machine to restore its saved conversation.";
  if (isTerminal(machine)) {
    const reason = machine.reason_code ? ` (${machine.reason_code})` : "";
    return `Machine is ${machine.state}${reason}. Use Relaunch machine, or Resume machine if it has a supported checkpoint.`;
  }
  if (["queued", "provisioning", "connected"].includes(machine.state))
    return `Machine is starting (${machineStateLabel(machine.state)}). Wait until its state is Ready.`;
  return `Machine is ${machineStateLabel(machine.state)}. Connect is available only when its state is Ready.`;
}
