// Machine-key scopes. A key never grants raw image, command, mount, network,
// privilege, or provider selection; templates are the only execution surface.

export const SCOPES = [
  "templates:read",
  "templates:write",
  "secrets:write",
  "workspaces:create",
  "workspaces:read",
  "workspaces:cancel",
  "workspaces:purge",
  "workspaces:recover",
  "principals:admin",
  "keys:read",
  "keys:write",
  "workspaces:preserve",
  "workspaces:restore",
  "checkpoints:read",
  "checkpoints:delete",
  "outputs:read",
  "conversations:read",
  "conversations:delete",
  "services:relay",
  "previews:open",
  "attachments:write",
  "logs:read",
  "network:read",
  "terminal:attach",
  "terminal:read",
  "admin",
] as const;

export type Scope = (typeof SCOPES)[number];

export function isScope(value: string): value is Scope {
  return (SCOPES as readonly string[]).includes(value);
}

export function hasScope(granted: readonly string[], required: Scope): boolean {
  return granted.includes(required) || granted.includes("admin");
}
