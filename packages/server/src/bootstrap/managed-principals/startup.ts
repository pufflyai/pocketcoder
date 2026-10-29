import type { Store } from "@pstdio/pocketcoder-runtime-core";
import type { StructuredLogger } from "../../observability/observability";
import { reconcileManagedPrincipals } from "./managed-principals";
import { readPrincipalFile } from "./principal-file";

export function managedPrincipalsConfig(env: Record<string, string | undefined>) {
  const file = env.POCKETCODER_PRINCIPALS_FILE;
  const dryRun = env.POCKETCODER_PRINCIPALS_DRY_RUN;
  if (dryRun !== undefined && dryRun !== "true" && dryRun !== "false") {
    throw new Error("POCKETCODER_PRINCIPALS_DRY_RUN must be true or false");
  }
  if (!file) {
    if (dryRun === "true") throw new Error("POCKETCODER_PRINCIPALS_DRY_RUN requires POCKETCODER_PRINCIPALS_FILE");
    return undefined;
  }
  return { file, dryRun: dryRun === "true" };
}

// The file is read once at startup. The returned task renews keys on a timer; a dry run has none.
export async function startManagedPrincipals(deps: {
  config: ReturnType<typeof managedPrincipalsConfig>;
  store: Store;
  pepper: string;
  logger: StructuredLogger;
}) {
  const { config } = deps;
  if (!config) return undefined;
  const file = await readPrincipalFile(config.file);
  const reconcile = async () => {
    await reconcileManagedPrincipals({ ...deps, file, dryRun: config.dryRun });
  };
  await reconcile();
  return config.dryRun ? undefined : reconcile;
}
