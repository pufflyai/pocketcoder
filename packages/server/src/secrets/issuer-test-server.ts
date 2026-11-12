import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digestOf } from "@pstdio/pocketcoder-contracts";

type Reply =
  | "refused"
  | "forbidden"
  | "valid"
  | "lost"
  | "wrong-workspace"
  | "long-expiry"
  | "redirect"
  | "outage"
  | "outage-stream"
  | "deep-policy";
type RequestIdentity = {
  session_id: string;
  generation: number;
  profile: string | null;
  owner: string;
  group: string;
  slot: string;
  request_id: string;
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

// A gateway fixture authenticates workspace bearers against live leases, as a real gateway would.
function liveWorkspace(requests: Map<string, IssuedLease>, credential: string) {
  const row = [...requests.values()].find(
    (r) => r.credential === credential && !r.revoked && r.expiresAt > new Date().toISOString(),
  );
  return row?.identity.session_id ?? null;
}

export async function createTestIssuer(
  options: { directoryRoot?: string; sourceUrl?: string; opensslBin?: string; resourceHost?: string } = {},
) {
  const directory = await mkdtemp(join(options.directoryRoot ?? tmpdir(), "pc-issuer-tls-"));
  try {
    const keyPath = join(directory, "key.pem");
    const certificatePath = join(directory, "cert.pem");
    let subjectAltName = "subjectAltName=IP:127.0.0.1,DNS:localhost";
    if (options.resourceHost) {
      const type = /^[0-9.]+$/.test(options.resourceHost) ? "IP" : "DNS";
      subjectAltName += `,${type}:${options.resourceHost}`;
    }
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
        subjectAltName,
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
    const revokedGenerations = new Map<string, number>();
    const controls = {
      reply: "valid" as Reply,
      authorization,
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
        row.identity.generation > (revokedGenerations.get(row.identity.session_id) ?? 0) &&
        row.expiresAt > new Date().toISOString() &&
        row.identity.session_id === url.searchParams.get("workspace") &&
        url.searchParams.get("resource") === policy.resource;
      return new Response(allowed ? "allowed" : "refused", { status: allowed ? 200 : 401 });
    }
    async function revoke(identity: RequestIdentity) {
      controls.revokeCalls++;
      await controls.beforeRevoke?.(identity);
      revokedGenerations.set(
        identity.session_id,
        Math.max(revokedGenerations.get(identity.session_id) ?? 0, identity.generation),
      );
      for (const row of requests.values())
        if (row.identity.session_id === identity.session_id && row.identity.generation <= identity.generation)
          row.revoked = true;
      return new Response(null, { status: 200 });
    }
    function nestedReply(reply: Record<string, unknown>) {
      const head = JSON.stringify({ ...reply, policy: undefined }).slice(0, -1);
      const nested = `${"[".repeat(12_000)}0${"]".repeat(12_000)}`;
      return new Response(`${head},"policy":{"nested":${nested}}}`, {
        headers: { "content-type": "application/json" },
      });
    }
    async function mint(identity: RequestIdentity, requestUrl: string) {
      if (digestOf(identity.policy) !== digestOf(policy)) return new Response("refused", { status: 403 });
      controls.mintCalls++;
      await controls.beforeMint?.(identity);
      const row: IssuedLease = {
        identity,
        credential: randomUUID().padEnd(controls.credentialBytes, "x"),
        lease_id: randomUUID(),
        revoked: identity.generation <= (revokedGenerations.get(identity.session_id) ?? 0),
        expiresAt: new Date(
          Math.min(Date.parse(identity.expires_at), Date.now() + (controls.leaseLifetimeMs ?? 300_000)),
        ).toISOString(),
      };
      requests.set(identity.request_id, row);
      controls.captured = row.credential;
      return mintReply(row, identity, requestUrl);
    }
    function mintReply(row: IssuedLease, identity: RequestIdentity, requestUrl: string) {
      if (controls.reply === "refused") return Response.json({ refused: true }, { status: 403 });
      if (controls.reply === "forbidden") return new Response("forbidden", { status: 403 });
      if (controls.reply === "deep-policy")
        return nestedReply({ ...identity, lease_id: row.lease_id, credential: row.credential });
      if (controls.reply === "lost") return new Response("lost response", { status: 503 });
      if (controls.reply === "redirect")
        return new Response(null, {
          status: 307,
          headers: { location: new URL("/redirect-target", requestUrl).href },
        });
      return Response.json({
        credential: row.credential,
        ...(controls.reply === "wrong-workspace" ? { session_id: randomUUID() } : {}),
        expires_at:
          controls.reply === "long-expiry"
            ? new Date(Date.parse(identity.expires_at) + 60000).toISOString()
            : row.expiresAt,
      });
    }

    const server = Bun.serve({
      hostname: options.resourceHost ? "0.0.0.0" : "127.0.0.1",
      port: 0,
      tls: { key, cert },
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/resource") return resourceResponse(request, url);
        if (url.pathname === "/redirect-target") {
          controls.redirectCalls++;
          return new Response("unexpected", { status: 500 });
        }
        if (request.headers.get("authorization") !== controls.authorization)
          return new Response("refused", { status: 401 });
        const input = (await request.json()) as RequestIdentity & { operation: string };
        const identity = input;
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
      directory,
      url: `https://127.0.0.1:${server.port}/leases`,
      resourceUrl: `https://${options.resourceHost ?? "127.0.0.1"}:${server.port}/resource`,
      ca: cert,
      authorization,
      policy,
      controls,
      authorizeSource(request: Request) {
        return [...requests.values()].some(
          (row) =>
            !row.revoked &&
            row.expiresAt > new Date().toISOString() &&
            new URL(request.url).pathname.startsWith(
              `${new URL(policy.repositories[0] ?? "https://invalid.example").pathname}/`,
            ) &&
            request.headers.get("authorization") === `Bearer ${row.credential}`,
        );
      },
      workspaceOf: (credential: string) => liveWorkspace(requests, credential),
      async resource(credential: string, workspaceId: string, resource = policy.resource) {
        const url = new URL(`https://127.0.0.1:${server.port}/resource`);
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
