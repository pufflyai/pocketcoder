import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DiscoveredProvider } from "@pstdio/pocketcoder-runtime-core";
import type { ServerConfig } from "../config/config";
import type { ServerLog } from "./lifecycle";
import { createWorkspaceDriver, initializeController } from "./lifecycle-resources";

type DiscoveryOutcome = { providers: DiscoveredProvider[] } | { error: unknown };

function startupDiscovery(config: ServerConfig, log: ServerLog) {
  let pending: Promise<DiscoveryOutcome> | undefined;
  return {
    async prepare(directory: string) {
      if (existsSync(join(directory, "db"))) return;
      // Only discovery uses this bootstrap driver; registry secrets and signing keys
      // are composed with the opened store before any provider mutation.
      pending = createWorkspaceDriver(config)
        .list()
        .then(
          (providers) => ({ providers }),
          (error) => ({ error }),
        );
      log("provider discovery started");
    },
    async providers() {
      const outcome = await pending;
      if (!outcome) return;
      if ("error" in outcome) throw outcome.error;
      return outcome.providers;
    },
    async settle() {
      // A failed database open must not leave a query or an unhandled rejection.
      await pending;
    },
  };
}

export async function initializeStartupController(config: ServerConfig, log: ServerLog) {
  const discovery = startupDiscovery(config, log);
  try {
    const initialized = await initializeController(config, log, discovery.prepare);
    return { initialized, discovery };
  } catch (error) {
    await discovery.settle();
    throw error;
  }
}
