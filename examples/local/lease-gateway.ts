import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digestOf } from "@pstdio/pocketcoder-contracts";
import { z } from "zod";

const Identity = z.object({
  session_id: z.uuid(),
  generation: z.number().int().positive(),
  profile: z.string().nullable(),
  owner: z.string(),
  group: z.string(),
  slot: z.string(),
  request_id: z.uuid(),
  expires_at: z.iso.datetime(),
  policy: z.record(z.string(), z.json()),
});
type Lease = { sessionId: string; generation: number; credential: string; expires_at: string };
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
  const revoked = new Map<string, number>();
  const issuer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { key, cert: ca },
    async fetch(request) {
      if (request.method !== "POST" || request.headers.get("authorization") !== authorization)
        return new Response(null, { status: 401 });
      const body = (await request.json()) as Record<string, unknown>;
      if (body.operation === "revoke") {
        const input = z.object({ session_id: z.uuid(), generation: z.number().int().positive() }).safeParse(body);
        if (!input.success) return new Response(null, { status: 400 });
        revoked.set(input.data.session_id, Math.max(revoked.get(input.data.session_id) ?? 0, input.data.generation));
        return new Response(null, { status: 200 });
      }
      const parsed = Identity.safeParse(body);
      if (!parsed.success || body.operation !== "mint") return new Response(null, { status: 400 });
      const identity = parsed.data;
      if (digestOf(identity.policy) !== digestOf(policy)) return new Response(null, { status: 403 });
      if (Date.parse(identity.expires_at) <= Date.now()) return new Response(null, { status: 410 });
      const row: Lease = {
        sessionId: identity.session_id,
        generation: identity.generation,
        credential: crypto.randomUUID(),
        expires_at: new Date(Math.min(Date.parse(identity.expires_at), Date.now() + 300000)).toISOString(),
      };
      leases.set(row.credential, row);
      return Response.json({ credential: row.credential, expires_at: row.expires_at });
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
          row.generation > (revoked.get(row.sessionId) ?? 0) &&
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
