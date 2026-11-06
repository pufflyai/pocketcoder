import {
  ApiError,
  canonicalJson,
  PREVIEW_GRANT_LEASE_MS,
  PreviewGrantCreateSchema,
  PreviewGrantRenewSchema,
} from "@pstdio/pocketcoder-contracts";
import type { Store, WorkspaceRow } from "@pstdio/pocketcoder-runtime-core";

export function previewIncarnation(workspace: WorkspaceRow) {
  return workspace.runtimeRegistration?.incarnationId ?? String(workspace.providerRef?.id ?? workspace.id);
}

export class PreviewGrants {
  constructor(private readonly store: Store) {}

  async create(workspace: WorkspaceRow, keyId: string, input: unknown) {
    const parsed = PreviewGrantCreateSchema.safeParse(input);
    if (!parsed.success) throw new ApiError("validation.invalid", "Invalid preview grant.");
    const value = parsed.data;
    const at = new Date();
    const key = await this.store.getMachineKeyWithPrincipal(keyId);
    const ceilingAt = new Date(value.ceilingAt);
    if (
      workspace.state !== "ready" ||
      workspace.purgeRequestedAt ||
      ceilingAt <= at ||
      ceilingAt > workspace.deadlineAt ||
      (key?.key.expiresAt !== null && key?.key.expiresAt !== undefined && ceilingAt > key.key.expiresAt) ||
      value.previews.some((name) => !Object.hasOwn(workspace.templateSnapshot.spec.previews ?? {}, name))
    )
      throw new ApiError("validation.invalid", "Preview grant exceeds workspace authority.");
    const row = {
      ...value,
      ceilingAt,
      workspaceId: workspace.id,
      incarnationId: previewIncarnation(workspace),
      principalId: workspace.principalId,
      keyId,
      createdAt: at,
      expiresAt: new Date(Math.min(at.getTime() + PREVIEW_GRANT_LEASE_MS, ceilingAt.getTime())),
      revokedAt: null,
    };
    const existing = await this.store.previewGrants.create(row);
    if (existing) return { created: true, grant: existing };
    const found = await this.get(workspace, keyId, value.id);
    const identity = (grant: Omit<typeof row, "revokedAt">) => ({
      workspaceId: grant.workspaceId,
      incarnationId: grant.incarnationId,
      keyId: grant.keyId,
      principalId: grant.principalId,
      subject: grant.subject,
      accessRevision: grant.accessRevision,
      previews: grant.previews,
      ceilingAt: grant.ceilingAt.toISOString(),
    });
    if (canonicalJson(identity(row)) !== canonicalJson(identity(found)))
      throw new ApiError("operation.conflict", "Grant identity is immutable.");
    return { created: false, grant: found };
  }

  async get(workspace: WorkspaceRow, keyId: string, id: string) {
    const grant = await this.store.previewGrants.get(id);
    if (
      !grant ||
      grant.workspaceId !== workspace.id ||
      grant.principalId !== workspace.principalId ||
      grant.keyId !== keyId ||
      grant.incarnationId !== previewIncarnation(workspace)
    )
      throw new ApiError("workspace.not_found", "Preview grant not found.");
    return grant;
  }

  async renew(workspace: WorkspaceRow, keyId: string, id: string, input: unknown) {
    const parsed = PreviewGrantRenewSchema.safeParse(input);
    if (!parsed.success) throw new ApiError("validation.invalid", "Invalid grant renewal.");
    const grant = await this.get(workspace, keyId, id);
    const now = new Date();
    const key = await this.store.getMachineKeyWithPrincipal(keyId);
    const expires = new Date(
      Math.min(
        now.getTime() + PREVIEW_GRANT_LEASE_MS,
        grant.ceilingAt.getTime(),
        workspace.deadlineAt.getTime(),
        key?.key.expiresAt?.getTime() ?? Infinity,
      ),
    );
    if (workspace.state !== "ready" || workspace.purgeRequestedAt || expires <= now)
      throw new ApiError("auth.invalid_key", "Grant authority has ended.");
    const renewed = await this.store.previewGrants.renew(id, parsed.data.accessRevision, expires, now);
    if (!renewed) throw new ApiError("auth.invalid_key", "Grant expired, revoked or changed revision.");
    return renewed;
  }
}
