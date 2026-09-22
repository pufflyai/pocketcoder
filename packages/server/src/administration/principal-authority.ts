import { ApiError } from "@pstdio/pocketcoder-contracts";
import type { AuthStore } from "@pstdio/pocketcoder-runtime-core";
import type { Context } from "hono";
import type { AppEnv } from "../http/middleware";

export async function managedPrincipal(context: Context<AppEnv>, store: AuthStore, id: string) {
  // No implicit admin bypass: delegated recovery must name its exact targets.
  if (!context.get("managedPrincipalIds").includes(id)) throw new ApiError("principal.not_found", "Unknown principal.");
  const principal = await store.getPrincipal(id);
  if (!principal) throw new ApiError("principal.not_found", "Unknown principal.");
  return principal;
}
