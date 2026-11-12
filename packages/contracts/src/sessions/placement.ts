import { digestOf } from "../common/canonical";
import type { Session, SessionProfile } from "./profile";

// Limits count across groups and versions; sharing includes both.
export function managedPlacement(
  principalId: string,
  session: Pick<Session, "sessionId" | "profile" | "owner" | "group">,
  profile: SessionProfile,
) {
  const mode = profile.placement;
  return {
    mode,
    key: digestOf({
      principalId,
      profile: session.profile,
      owner: session.owner,
      group: session.group,
      template: profile.template,
      templateVersion: profile.templateVersion,
      sessionId: mode === "exclusive" ? session.sessionId : null,
    }),
  };
}
export const MANAGED_SESSION_METADATA = "pocketcoder.managed-session";
