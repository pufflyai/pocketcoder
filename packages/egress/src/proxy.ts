import { lookup } from "node:dns/promises";
import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import { connect } from "node:net";
import {
  findNetworkRule,
  isPrivateAddress,
  type NetworkEventInput,
  type NetworkPolicy,
} from "@pstdio/pocketcoder-contracts";

type Address = { address: string; family: number };
type Validation =
  | { rule: NonNullable<ReturnType<typeof findNetworkRule>>; address: Address }
  | { rule?: NonNullable<ReturnType<typeof findNetworkRule>>; reason: string };

type ProxyOptions = {
  policy: NetworkPolicy;
  resolve?: (host: string) => Promise<Address[]>;
  record: (event: NetworkEventInput) => void;
  canAccept?: () => boolean;
  host?: string;
  port?: number;
};

const HOP_HEADERS = new Set(["proxy-authorization", "proxy-connection"]);

function requestHeaders(request: IncomingMessage) {
  return Object.fromEntries(
    Object.entries(request.headers).filter(([name]) => !HOP_HEADERS.has(name.toLowerCase())),
  );
}

function connectTarget(value: string) {
  const match = /^([a-z0-9.-]+):(\d{1,5})$/.exec(value.toLowerCase());
  if (!match) return null;
  const port = Number(match[2]);
  if (port < 1 || port > 65_535) return null;
  return { host: match[1] as string, port };
}

export async function startProxy(options: ProxyOptions) {
  let sequence = 0;
  const resolve =
    options.resolve ??
    (async (host: string) => lookup(host, { all: true, verbatim: true }) as Promise<Address[]>);
  const record = (
    input: Omit<
      NetworkEventInput,
      "source_seq" | "occurred_at" | "method" | "path" | "matched_rule"
    > &
      Partial<Pick<NetworkEventInput, "method" | "path" | "matched_rule">>,
  ) => {
    options.record({
      ...input,
      source_seq: ++sequence,
      occurred_at: new Date().toISOString(),
      method: input.method ?? null,
      path: input.path ?? null,
      matched_rule: input.matched_rule ?? null,
    });
  };
  const admit = (response: { writeHead(status: number): unknown; end(): unknown }) => {
    if (options.canAccept?.() !== false) return true;
    response.writeHead(503);
    response.end();
    return false;
  };
  const validate = async (host: string, port: number): Promise<Validation> => {
    const rule = findNetworkRule(options.policy, host, port);
    if (!rule) return { reason: "no_matching_rule" } as const;
    let addresses: Address[];
    try {
      addresses = await resolve(host);
    } catch {
      return { rule, reason: "dns_failed" } as const;
    }
    if (addresses.length === 0) return { rule, reason: "dns_failed" } as const;
    if (!rule.allowPrivate && addresses.some(({ address }) => isPrivateAddress(address))) {
      return { rule, reason: "private_address" } as const;
    }
    return { rule, address: addresses[0] as Address } as const;
  };

  const server = createServer(async (request, response) => {
    if (!admit(response)) return;
    let target: URL;
    try {
      target = new URL(request.url ?? "");
      if (target.protocol !== "http:" || target.username || target.password) throw new Error();
    } catch {
      record({
        decision: "deny",
        transport: "http",
        host: "invalid",
        port: 80,
        reason: "malformed_target",
      });
      response.writeHead(400);
      response.end();
      return;
    }
    const host = target.hostname.toLowerCase();
    const port = Number(target.port || 80);
    const result = await validate(host, port);
    if ("reason" in result) {
      record({ decision: "deny", transport: "http", host, port, reason: result.reason });
      response.writeHead(403);
      response.end();
      return;
    }
    const upstream = httpRequest(
      {
        host: result.address.address,
        port,
        method: request.method,
        path: `${target.pathname}${target.search}`,
        headers: { ...requestHeaders(request), host: target.host },
      },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      },
    );
    upstream.on("error", () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    request.pipe(upstream);
    record({
      decision: "allow",
      transport: "http",
      host,
      port,
      method: request.method ?? null,
      path: target.pathname,
      matched_rule: result.rule.domain,
      reason: "matched_rule",
    });
  });

  server.on("connect", async (request, client, head) => {
    if (options.canAccept?.() === false) {
      client.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
      client.destroy();
      return;
    }
    const target = connectTarget(request.url ?? "");
    if (!target) {
      record({
        decision: "deny",
        transport: "https",
        host: "invalid",
        port: 443,
        reason: "malformed_target",
      });
      client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    const result = await validate(target.host, target.port);
    if ("reason" in result) {
      record({
        decision: "deny",
        transport: "https",
        host: target.host,
        port: target.port,
        reason: result.reason,
      });
      client.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      client.destroy();
      return;
    }
    const upstream = connect(target.port, result.address.address, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
      record({
        decision: "allow",
        transport: "https",
        host: target.host,
        port: target.port,
        matched_rule: result.rule.domain,
        reason: "matched_rule",
      });
    });
    upstream.on("error", () => client.destroy());
  });
  server.on("clientError", (_error, socket) => {
    const accepted = options.canAccept?.() !== false;
    if (accepted) {
      record({
        decision: "deny",
        transport: "https",
        host: "invalid",
        port: 443,
        reason: "malformed_target",
      });
    }
    socket.end(
      !accepted ? "HTTP/1.1 503 Service Unavailable\r\n\r\n" : "HTTP/1.1 400 Bad Request\r\n\r\n",
    );
  });

  await new Promise<void>((resolveListen) =>
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", resolveListen),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("proxy did not bind a TCP port");
  return {
    port: address.port,
    close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
  };
}
