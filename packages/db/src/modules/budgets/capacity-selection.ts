import type { DatabaseContext } from "../../database/context";
import { parallel } from "./capacity-capabilities";

type Capacity = DatabaseContext["tables"]["managedCapacity"]["$inferSelect"];
type Workspace = DatabaseContext["tables"]["workspaces"]["$inferSelect"];
type Request = DatabaseContext["tables"]["conversationRequests"]["$inferSelect"];
export function sharedCandidate(available: Capacity[], workspaces: Workspace[], limit: number) {
  const candidates = available.filter((r) => {
    const w = workspaces.find((w) => w.id === r.workspaceId);
    return (
      w &&
      !w.terminalAt &&
      !w.purgeRequestedAt &&
      !w.runtimeRegistration?.endedAt &&
      ["queued", "provisioning", "connected", "ready"].includes(w.state) &&
      parallel(w.runtimeRegistration?.producer) &&
      r.record.sessions.filter((s) => !s.stoppedAt).length < limit
    );
  });
  return candidates.sort((a, b) => b.record.sessions.length - a.record.sessions.length)[0]?.workspaceId;
}
export function launchingCandidate(available: Capacity[], workspaces: Workspace[]) {
  return available.some((r) => {
    const w = workspaces.find((w) => w.id === r.workspaceId);
    return !w || (!w.terminalAt && ["queued", "provisioning", "connected"].includes(w.state));
  });
}
export function idleVictim(
  owned: Capacity[],
  workspaces: Workspace[],
  requests: Request[],
  templateDigest: string,
  group: string,
) {
  const idle = owned.filter(
    (r) =>
      workspaces.some((w) => w.id === r.workspaceId && w.state === "ready") &&
      !r.record.drainingAt &&
      !requests.some((q) => q.workspaceId === r.workspaceId && q.execution && !q.execution.finalizedAt),
  );
  return idle.sort(
    (a, b) =>
      Number(b.record.templateDigest !== templateDigest) - Number(a.record.templateDigest !== templateDigest) ||
      Number(b.record.group !== group) - Number(a.record.group !== group) ||
      a.record.lastUsedAt.localeCompare(b.record.lastUsedAt),
  )[0];
}
