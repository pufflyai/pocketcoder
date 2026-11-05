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
