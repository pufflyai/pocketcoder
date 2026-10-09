import { randomUUID } from "node:crypto";
import { PGliteStore } from "@pstdio/pocketcoder-db";
import { bootstrapLocalOwnerKey } from "@pstdio/pocketcoder-runtime-core";
import { PocketCoderClient, type PrincipalCreateRequest } from "@pstdio/pocketcoder-sdk";

export async function bootstrapExampleOwner(dataDir: string, pepper: string, expiresAt: Date) {
  const store = await PGliteStore.create(dataDir);
  try {
    const result = await bootstrapLocalOwnerKey(store, pepper, {
      request_id: `example-owner-${randomUUID()}`,
      expires_at: expiresAt.toISOString(),
    });
    if (!result.token) throw new Error("Example owner bootstrap returned no new key.");
    return result.token;
  } finally {
    await store.close();
  }
}

export async function issueExampleAccess(
  baseUrl: string,
  ownerKey: string,
  input: PrincipalCreateRequest & { expiresAt: Date },
) {
  const client = new PocketCoderClient({ baseUrl, apiKey: ownerKey });
  const principal = await client.principals.create({
    name: input.name,
    scopes: input.scopes,
    templates: input.templates,
  });
  const result = await client.keys.issue(principal.id, {
    request_id: `example-key-${randomUUID()}`,
    scopes: input.scopes,
    templates: input.templates,
    expires_at: input.expiresAt.toISOString(),
  });
  if (!result.token) throw new Error("Example issuance returned no new key.");
  return result.token;
}
