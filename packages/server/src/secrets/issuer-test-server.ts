import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digestOf } from "@pstdio/pocketcoder-contracts";

type Reply =
  | "valid"
  | "lost"
  | "wrong-workspace"
  | "long-expiry"
  | "redirect"
  | "outage"
  | "outage-stream"
  | "deep-policy";
type RequestIdentity = {
  workspace_id: string;
  source_url: string;
  source_revision: string;
  template_digest: string;
  request_id: string;
  request_digest: string;
  policy_digest: string;
  purpose: string;
  expires_at: string;
  policy: Record<string, unknown>;
};
type IssuedLease = {
  identity: RequestIdentity;
  credential: string;
  lease_id: string;
  revoked: boolean;
  expiresAt: string;
};

export async function createTestIssuer(
  options: { directoryRoot?: string; sourceUrl?: string; opensslBin?: string } = {},
) {
  const directory = await mkdtemp(join(options.directoryRoot ?? tmpdir(), "pc-issuer-tls-"));
  try {
    const keyPath = join(directory, "key.pem");
    const certificatePath = join(directory, "cert.pem");
    const certificate = Bun.spawn(
      [
        options.opensslBin ?? "openssl",
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
    if (await certificate.exited) {
      await rm(directory, { recursive: true, force: true });
      throw new Error("Test issuer TLS setup failed");
    }
    await chmod(keyPath, 0o600);
    const [key, cert] = await Promise.all([readFile(keyPath, "utf8"), readFile(certificatePath, "utf8")]);
    const authorization = `Bearer ${randomUUID()}`;
    const policy = {
      resource: "synthetic-source",
      repositories: [options.sourceUrl ?? "https://source.example/private.git"],
    };
    const requests = new Map<string, IssuedLease>();
    const tombstones = new Set<string>();
    const controls = {
      reply: "valid" as Reply,
      beforeMint: undefined as ((input: RequestIdentity) => Promise<void>) | undefined,
      beforeRevoke: undefined as ((input: RequestIdentity) => Promise<void>) | undefined,
      captured: "",
      leaseLifetimeMs: undefined as number | undefined,
      credentialBytes: 36,
      mintCalls: 0,
      revokeCalls: 0,
      redirectCalls: 0,
      errorCancelled: Promise.withResolvers<void>(),
    };
    function resourceResponse(request: Request, url: URL) {
      const row = [...requests.values()].find(
        (row) => `Bearer ${row.credential}` === request.headers.get("authorization"),
      );
      const allowed =
        row &&
        !row.revoked &&
        row.expiresAt > new Date().toISOString() &&
        row.identity.workspace_id === url.searchParams.get("workspace") &&
        url.searchParams.get("resource") === policy.resource;
      return new Response(allowed ? "allowed" : "refused", { status: allowed ? 200 : 401 });
    }
    async function revoke(identity: RequestIdentity) {
      controls.revokeCalls++;
      await controls.beforeRevoke?.(identity);
      const existing = requests.get(identity.request_id);
      if (existing && digestOf(existing.identity) !== digestOf(identity))
        return new Response("conflict", { status: 409 });
      tombstones.add(identity.request_id);
      if (existing) existing.revoked = true;
      if (controls.reply === "deep-policy") return nestedReply({ ...identity, revoked: true });
      return Response.json({ ...identity, revoked: true });
    }
    function nestedReply(reply: Record<string, unknown>) {
      const head = JSON.stringify({ ...reply, policy: undefined }).slice(0, -1);
      const nested = `${"[".repeat(12_000)}0${"]".repeat(12_000)}`;
      return new Response(`${head},"policy":{"nested":${nested}}}`, {
        headers: { "content-type": "application/json" },
      });
    }
    async function mint(identity: RequestIdentity, requestUrl: string) {
      if (tombstones.has(identity.request_id)) return new Response("revoked", { status: 409 });
      if (!policy.repositories.includes(identity.source_url)) return new Response("refused", { status: 403 });
      if (digestOf(identity.policy) !== digestOf(policy) || identity.policy_digest !== digestOf(policy))
        return new Response("refused", { status: 403 });
      controls.mintCalls++;
      await controls.beforeMint?.(identity);
      // Revoke is a request-ID tombstone, including when mint was already in flight.
      if (tombstones.has(identity.request_id)) return new Response("revoked", { status: 409 });
      let row = requests.get(identity.request_id);
      if (row && digestOf(row.identity) !== digestOf(identity)) return new Response("conflict", { status: 409 });
      if (!row) {
        row = {
          identity,
          credential: randomUUID().padEnd(controls.credentialBytes, "x"),
          lease_id: randomUUID(),
          revoked: false,
          expiresAt: new Date(
            Math.min(Date.parse(identity.expires_at), Date.now() + (controls.leaseLifetimeMs ?? 300_000)),
          ).toISOString(),
        };
        requests.set(identity.request_id, row);
      }
      controls.captured = row.credential;
      return mintReply(row, identity, requestUrl);
    }
    function mintReply(row: IssuedLease, identity: RequestIdentity, requestUrl: string) {
      if (controls.reply === "deep-policy")
        return nestedReply({ ...identity, lease_id: row.lease_id, credential: row.credential });
      if (controls.reply === "lost") return new Response("lost response", { status: 503 });
      if (controls.reply === "redirect")
        return new Response(null, {
          status: 307,
          headers: { location: new URL("/redirect-target", requestUrl).href },
        });
      return Response.json({
        ...identity,
        lease_id: row.lease_id,
        credential: row.credential,
        workspace_id: controls.reply === "wrong-workspace" ? randomUUID() : identity.workspace_id,
        expires_at:
          controls.reply === "long-expiry"
            ? new Date(Date.parse(identity.expires_at) + 60_000).toISOString()
            : row.expiresAt,
      });
    }
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      tls: { key, cert },
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/resource") return resourceResponse(request, url);
        if (url.pathname === "/redirect-target") {
          controls.redirectCalls++;
          return new Response("unexpected", { status: 500 });
        }
        if (request.headers.get("authorization") !== authorization) return new Response("refused", { status: 401 });
        const input = (await request.json()) as RequestIdentity & { operation: string };
        const identity = {
          workspace_id: input.workspace_id,
          source_url: input.source_url,
          source_revision: input.source_revision,
          template_digest: input.template_digest,
          request_id: input.request_id,
          request_digest: input.request_digest,
          policy_digest: input.policy_digest,
          purpose: input.purpose,
          expires_at: input.expires_at,
          policy: input.policy,
        };
        if (controls.reply === "outage") return new Response("operator-only error", { status: 503 });
        if (controls.reply === "outage-stream") {
          const body = new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(4096));
            },
            cancel() {
              controls.errorCancelled.resolve();
            },
          });
          return new Response(body, { status: 503 });
        }
        if (input.operation === "revoke") return revoke(identity);
        return mint(identity, request.url);
      },
    });
    return {
      url: new URL("/leases", server.url).href,
      ca: cert,
      authorization,
      policy,
      controls,
      authorizeSource(request: Request) {
        return [...requests.values()].some(
          (row) =>
            !row.revoked &&
            row.expiresAt > new Date().toISOString() &&
            new URL(request.url).pathname.startsWith(`${new URL(row.identity.source_url).pathname}/`) &&
            request.headers.get("authorization") === `Bearer ${row.credential}`,
        );
      },
      async resource(credential: string, workspaceId: string, resource = policy.resource) {
        const url = new URL("/resource", server.url);
        url.searchParams.set("workspace", workspaceId);
        url.searchParams.set("resource", resource);
        return (await fetch(url, { headers: { authorization: `Bearer ${credential}` }, tls: { ca: cert } })).status;
      },
      async close() {
        await server.stop(true);
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
