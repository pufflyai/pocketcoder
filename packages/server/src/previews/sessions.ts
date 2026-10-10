import { createHash, randomBytes } from "node:crypto";
import { ApiError, hasScope } from "@pstdio/pocketcoder-contracts";
import { keyAuthority, type Store } from "@pstdio/pocketcoder-runtime-core";
import { templateAuthorized, type WorkspaceService } from "../workspaces/service";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export interface PreviewSession {
  workspaceId: string;
  name: string;
  origin: string;
  keyId: string;
  expires: number;
  control?: boolean;
}

export class PreviewSessions {
  private readonly tokens = new Map<string, PreviewSession>();
  private readonly sessions = new Map<string, PreviewSession>();

  constructor(
    private readonly store: Store,
    private readonly service: WorkspaceService,
  ) {}

  async mint(workspaceId: string, name: string, origin: string, keyId: string, control = false) {
    this.sweep();
    if (this.tokens.size + this.sessions.size >= 4096)
      throw new ApiError("operation.conflict", "Preview session limit reached.");
    const session = { workspaceId, name, origin, keyId, control, expires: Date.now() + 60 * 60_000 };
    const { workspace, key } = await this.authorize(session);
    session.expires = Math.min(session.expires, workspace.deadlineAt.getTime(), key.expiresAt?.getTime() ?? Infinity);
    const token = randomBytes(32).toString("base64url");
    this.tokens.set(digest(token), { ...session, expires: Math.min(session.expires, Date.now() + 60_000) });
    return { token, expires: session.expires };
  }

  async exchange(token: string, origin: string) {
    const tokenId = digest(token);
    const session = this.tokens.get(tokenId);
    if (!session || session.origin !== origin) throw new ApiError("auth.invalid_key", "Invalid preview token.");
    // Consume before awaiting authority, so concurrent exchanges cannot replay it.
    this.tokens.delete(tokenId);
    const { workspace, key } = await this.authorize(session);
    session.expires = Math.min(
      Date.now() + 60 * 60_000,
      workspace.deadlineAt.getTime(),
      key.expiresAt?.getTime() ?? Infinity,
    );
    const secret = randomBytes(32).toString("base64url");
    this.sessions.set(digest(secret), session);
    return { secret, session };
  }

  async lookup(secret: string, origin: string) {
    const session = this.sessions.get(digest(secret));
    if (!session || session.origin !== origin) throw new ApiError("auth.invalid_key", "Invalid preview session.");
    await this.authorize(session);
    return session;
  }

  async authorize(session: PreviewSession) {
    if (session.expires <= Date.now()) throw new ApiError("auth.invalid_key", "Preview session expired.");
    const found = await this.store.getMachineKeyWithPrincipal(session.keyId);
    if (!found) throw new ApiError("auth.invalid_key", "Preview key no longer exists.");
    const authority = keyAuthority(found.principal, found.key, new Date());
    const scope = session.name === "display" ? "display:view" : "previews:open";
    if (!hasScope(authority.scopes, scope)) throw new ApiError("auth.invalid_key", "Preview permission was removed.");
    if (session.control && !hasScope(authority.scopes, "display:control"))
      throw new ApiError("auth.missing_scope", "Display control permission was removed.");
    const principal = { ...found.principal, templateNames: authority.templateNames };
    const workspace = await this.service.getOwned(principal, session.workspaceId);
    if (!templateAuthorized(principal, workspace.templateName))
      throw new ApiError("auth.invalid_key", "Template permission was removed.");
    if (workspace.state !== "ready" || workspace.purgeRequestedAt || workspace.deadlineAt.getTime() <= Date.now()) {
      throw new ApiError("workspace.not_ready", "Workspace preview is not active.");
    }
    const preview = workspace.templateSnapshot.spec.previews?.[session.name];
    if (session.name === "display") {
      if (!workspace.templateSnapshot.spec.display)
        throw new ApiError("validation.invalid", "Display is not declared by the workspace template.");
    } else if (!preview) throw new ApiError("validation.invalid", "Preview is not declared by the workspace template.");
    return { workspace, key: found.key, preview };
  }

  private sweep() {
    for (const entries of [this.tokens, this.sessions]) {
      for (const [id, session] of entries) if (session.expires <= Date.now()) entries.delete(id);
    }
  }
}
