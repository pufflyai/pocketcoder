import { readFile } from "node:fs/promises";
import { NetworkPolicySchema } from "@pstdio/pocketcoder-contracts";
import { z } from "zod";
import { AuditQueue } from "./audit";
import { configureFirewall } from "./firewall";
import { startProxy } from "./proxy";
import { startControlRelay } from "./relay";

const ConfigSchema = z.object({
  policy: NetworkPolicySchema,
  control_url: z.url(),
  audit_url: z.url(),
  audit_token: z.string().min(1),
});

async function main() {
  if (process.argv[2] === "health") {
    const response = await fetch("http://127.0.0.1:18082/readyz", {
      signal: AbortSignal.timeout(1000),
    });
    process.exit(response.ok ? 0 : 1);
  }
  const configPath = process.env.POCKETCODER_EGRESS_CONFIG ?? "/run/pocketcoder/egress.json";
  const config = ConfigSchema.parse(JSON.parse(await readFile(configPath, "utf8")));
  if (config.policy.mode !== "restricted") throw new Error("egress requires a restricted policy");
  await configureFirewall(999);
  if (!process.setgid || !process.setuid)
    throw new Error("POSIX identity controls are unavailable");
  process.setgid(999);
  process.setuid(999);

  const audit = new AuditQueue(config.audit_url, config.audit_token);
  const proxy = await startProxy({
    policy: config.policy,
    host: "127.0.0.1",
    port: 18_080,
    record: (event) => audit.record(event),
    canAccept: () => audit.canAccept(),
  });
  const relay = startControlRelay(config.control_url);
  const health = Bun.serve({
    hostname: "127.0.0.1",
    port: 18_082,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path !== "/healthz" && path !== "/readyz")
        return new Response("not found", { status: 404 });
      return Response.json(
        {
          ok: audit.canAccept(),
          proxy_port: proxy.port,
          relay_port: relay.port,
        },
        { status: audit.canAccept() ? 200 : 503 },
      );
    },
  });

  const shutdown = () => {
    audit.close();
    void proxy.close();
    relay.close();
    health.stop(true);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`pocketcoder-egress: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  });
}
