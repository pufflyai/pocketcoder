import { runtimeCredentialReferences } from "@pstdio/pocketcoder-contracts";
import type { WorkspaceLeasePurpose, WorkspaceRow } from "@pstdio/pocketcoder-runtime-contracts";

export function leaseWorkspaceActive(owner: WorkspaceRow, purpose: WorkspaceLeasePurpose, at: Date) {
  const states = purpose === "setup-issuer" ? ["provisioning"] : ["provisioning", "connected", "ready"];
  return states.includes(owner.state) && !owner.purgeRequestedAt && owner.deadlineAt > at;
}

export function leaseSourceIdentity(owner: WorkspaceRow, purpose: WorkspaceLeasePurpose, name: string) {
  if (purpose === "runtime-issuer") {
    if (!runtimeCredentialReferences(owner.templateSnapshot.spec).includes(name))
      throw new Error("Runtime lease reference is unavailable");
    return { sourceUrl: null, sourceRevision: null };
  }
  const source = owner.sourceDescriptor;
  const repository = source && owner.templateSnapshot.spec.source?.repositories[source.repository];
  if (owner.launchMode !== "create" || !source || !repository || repository.credential !== `secretRef:${name}`)
    throw new Error("Lease source reference is unavailable");
  return { sourceUrl: repository.url, sourceRevision: source.revision };
}
