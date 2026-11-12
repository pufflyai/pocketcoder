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

// Each pass re-reads configuration so changes do not interrupt running turns.
export async function startManagedPrincipals(deps: {
  config: ReturnType<typeof managedPrincipalsConfig>;
  store: Store;
  pepper: string;
  logger: StructuredLogger;
}) {
  const { config } = deps;
  if (!config) return undefined;
  const reconcile = async () => {
    const file = await readPrincipalFile(config.file);
    await reconcileManagedPrincipals({ ...deps, file, dryRun: config.dryRun });
  };
  await reconcile();
  return config.dryRun ? undefined : reconcile;
}
