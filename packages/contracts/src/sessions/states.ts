import { z } from "zod";
import type { Session } from "./profile";
import type { Request } from "./request";

const requestTransitions: Record<Request["state"], readonly Request["state"][]> = {
  accepted: ["waiting", "running", "checking_outcome", "terminal"],
  waiting: ["running", "checking_outcome", "terminal"],
  running: ["checking_outcome", "terminal"],
  checking_outcome: ["running", "terminal"],
  terminal: [],
};
const sessionTransitions: Record<Session["state"], readonly Session["state"][]> = {
  provisioning: ["ready", "suspended", "closed", "failed"],
  ready: ["provisioning", "suspended", "closed", "failed"],
  suspended: ["provisioning", "closed", "failed"],
  closed: [],
  failed: ["provisioning", "closed"],
};

export const canTransitionRequest = (from: Request["state"], to: Request["state"]) =>
  requestTransitions[from].includes(to);
export const canTransitionSession = (from: Session["state"], to: Session["state"]) =>
  sessionTransitions[from].includes(to);

// Deployments must publish both bounds. There is no implicit unbounded queue.
export const ManagedQueueLimitsSchema = z.strictObject({
  requests: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export type ManagedQueueLimits = z.infer<typeof ManagedQueueLimitsSchema>;
