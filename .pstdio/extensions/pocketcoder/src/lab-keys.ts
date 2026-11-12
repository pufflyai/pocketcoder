import { randomUUID } from "node:crypto";
import { type KeyIssueRequest, PocketCoderClient } from "@pstdio/pocketcoder-sdk";
import type { Instance } from "./instances";
import { createOwnerKeys, type OwnerKey } from "./owner-keys";

// All machines in one Lab use the configured principal. The chat key gets only session access.
export const labScopes: KeyIssueRequest["scopes"] = [
  "templates:read",
  "templates:write",
  "secrets:write",
  "keys:read",
  "keys:write",
  "workspaces:create",
  "workspaces:read",
  "workspaces:cancel",
  "workspaces:purge",
  "workspaces:recover",
  "workspaces:preserve",
  "workspaces:restore",
  "checkpoints:read",
  "checkpoints:delete",
  "outputs:read",
  "conversations:read",
  "conversations:write",
  "conversations:delete",
  "services:relay",
  "previews:open",
  "display:view",
  "display:control",
  "attachments:write",
  "logs:read",
  "network:read",
  "terminal:attach",
  "terminal:read",
  "sessions:read",
  "sessions:write",
];

async function issueLabKey(
  client: PocketCoderClient,
  principalId: string,
  expiresAt: string,
  scopes: KeyIssueRequest["scopes"],
) {
  const issued = await client.keys.issue(principalId, {
    request_id: randomUUID(),
    scopes,
    templates: ["*"],
    expires_at: expiresAt,
  });
  if (!issued.token) throw new Error("The new Lab key was not returned.");
  return { token: issued.token, key: { principal_id: issued.key.principal_id, expires_at: expiresAt } };
}

async function issueLabOperator(
  url: string,
  bootstrap: { token: string; key: { id: string; principal_id: string } },
  expiresAt: string,
) {
  const client = new PocketCoderClient({ baseUrl: url, apiKey: bootstrap.token });
  try {
    const principal = (await client.principals.list()).items.find((item) => item.name === "lab");
    if (!principal) throw new Error("The Lab principal was not reconciled.");
    return await issueLabKey(client, principal.id, expiresAt, labScopes);
  } finally {
    await client.keys.revoke(bootstrap.key.principal_id, bootstrap.key.id);
  }
}

export function createLabKeys(deps: {
  read: (id: string, file: string) => Promise<OwnerKey>;
  write: (id: string, file: string, key: OwnerKey) => Promise<void>;
  cli: (instance: Instance, args: string[]) => Promise<string>;
  get: (id: string) => Promise<Instance>;
}) {
  const operator = createOwnerKeys({
    read: (id) => deps.read(id, "owner.json"),
    // The bootstrap owner key stays in memory. Only the Lab principal's operator key is saved.
    write: (id, key) => deps.write(id, "owner.json", key),
    create: async (instance, expiresAt) => {
      const bootstrap = JSON.parse(
        await deps.cli(instance, ["superuser", "create", "--automation", "--expires", expiresAt, "--json"]),
      );
      return issueLabOperator(instance.url, bootstrap, expiresAt);
    },
    get: deps.get,
  });
  const consumer = createOwnerKeys({
    read: (id) => deps.read(id, "managed.json"),
    write: (id, key) => deps.write(id, "managed.json", key),
    create: async (instance, expiresAt) => {
      const token = await operator.token(instance.id);
      const owner = await deps.read(instance.id, "owner.json");
      return issueLabKey(
        new PocketCoderClient({ baseUrl: instance.url, apiKey: token }),
        owner.principalId,
        new Date(Math.min(Date.parse(expiresAt), Date.parse(owner.expiresAt))).toISOString(),
        ["sessions:read", "sessions:write"],
      );
    },
    get: deps.get,
  });
  return { operator, consumer };
}
