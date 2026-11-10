import { digestOf } from "../common/canonical";
import { type ExecutionProfile, ExecutionProfileSchema } from "./profile";

// This describes compatibility; only the placement owner may allocate a workspace.
export function managedPlacement(principalId: string, sessionId: string, input: ExecutionProfile) {
  const profile = ExecutionProfileSchema.parse(input);
  const mode = profile.credentialBindingId === null ? "shared" : "exclusive";
  return {
    mode,
    key: digestOf({ principalId, profile, sessionId: mode === "exclusive" ? sessionId : null }),
  };
}

// Workspace metadata naming the session whose placement owner created it. Launch waits for its capacity.
export const MANAGED_SESSION_METADATA = "pocketcoder.managed-session";
