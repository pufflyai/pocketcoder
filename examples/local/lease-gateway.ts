import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digestOf } from "@pstdio/pocketcoder-contracts";
import { z } from "zod";

const Identity = z.object({
  workspace_id: z.uuid(),
  source_url: z.string().nullable(),
  source_revision: z.string().nullable(),
  template_digest: z.string(),
  request_id: z.uuid(),
  request_digest: z.string(),
  policy_digest: z.string(),
  purpose: z.literal("runtime-issuer"),
  expires_at: z.iso.datetime(),
  policy: z.record(z.string(), z.json()),
});
type Lease = {
  identity: z.infer<typeof Identity>;
  fingerprint: string;
  lease_id: string;
  credential: string;
  expires_at: string;
  revoked: boolean;
};
const paths = new Set(["/v1/chat/completions", "/v1/responses"]);

// Only the controller holds issuer authority. Workspaces receive separate, expiring leases.
export async function startLeaseGateway(options: { upstreamUrl: string; upstreamBearer?: string; port?: number }) {
  const directory = await mkdtemp(join(tmpdir(), "pc-local-issuer-"));
  const keyPath = join(directory, "key.pem");
  const certificatePath = join(directory, "cert.pem");
  const child = Bun.spawn(
    [
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=IP:127.0.0.1,DNS:localhost",
      "-keyout",
      keyPath,
      "-out",
      certificatePath,
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  if (await child.exited) {
    await rm(directory, { recursive: true, force: true });
    throw new Error("Could not create local issuer certificate");
  }
  await chmod(keyPath, 0o600);
  const key = await readFile(keyPath, "utf8");
  const ca = await readFile(certificatePath, "utf8");
  const authorization = `Bearer ${crypto.randomUUID()}`;
  const policy = { resource: "pi-model-gateway" };
  const leases = new Map<string, Lease>();
  const issuer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { key, cert: ca },
    async fetch(request) {
      if (request.method !== "POST" || request.headers.get("authorization") !== authorization)
        return new Response(null, { status: 401 });
      const parsed = Identity.extend({ operation: z.enum(["mint", "revoke"]) }).safeParse(await request.json());
      if (!parsed.success) return new Response(null, { status: 400 });
      const { operation, ...identity } = parsed.data;
      const fingerprint = digestOf(identity);
      if (identity.policy_digest !== digestOf(policy) || digestOf(identity.policy) !== digestOf(policy))
        return new Response(null, { status: 403 });
      const existing = leases.get(identity.request_id);
      if (existing && existing.fingerprint !== fingerprint) return new Response(null, { status: 409 });
      if (operation === "revoke") {
        const row = existing ?? {
          identity,
          fingerprint,
          lease_id: crypto.randomUUID(),
          credential: "",
          expires_at: identity.expires_at,
          revoked: true,
        };
        row.revoked = true;
        leases.set(identity.request_id, row);
        return Response.json({ ...identity, revoked: true });
      }
      if (existing?.revoked) return new Response(null, { status: 410 });
      if (Date.parse(identity.expires_at) <= Date.now()) return new Response(null, { status: 410 });
      const row = existing ?? {
        identity,
        fingerprint,
        lease_id: crypto.randomUUID(),
        credential: crypto.randomUUID(),
        expires_at: new Date(Math.min(Date.parse(identity.expires_at), Date.now() + 2 * 60 * 60_000)).toISOString(),
        revoked: false,
      };
      leases.set(identity.request_id, row);
      return Response.json({
        ...identity,
        lease_id: row.lease_id,
        credential: row.credential,
        expires_at: row.expires_at,
      });
    },
  });
  const server = Bun.serve({
    hostname: "0.0.0.0",
    port: options.port ?? 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method !== "POST" || !paths.has(path)) return new Response(null, { status: 404 });
      const lease = [...leases.values()].find(
        (row) =>
          `Bearer ${row.credential}` === request.headers.get("authorization") &&
          !row.revoked &&
          Date.parse(row.expires_at) > Date.now(),
      );
      if (!lease) return new Response(null, { status: 401 });
      const body = await request.arrayBuffer();
      if (body.byteLength > 1024 * 1024) return new Response(null, { status: 413 });
      const headers = new Headers({ "content-type": "application/json" });
      if (options.upstreamBearer) headers.set("authorization", `Bearer ${options.upstreamBearer}`);
      return fetch(new URL(path, options.upstreamUrl), {
        method: "POST",
        headers,
        body,
        signal: request.signal,
        redirect: "error",
      });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    port: server.port,
    ca,
    config: { url: `https://127.0.0.1:${issuer.port}/leases`, authorization, policy },
    async close() {
      leases.clear();
      await Promise.all([server.stop(true), issuer.stop(true)]);
      await rm(directory, { recursive: true, force: true });
    },
  };
}
