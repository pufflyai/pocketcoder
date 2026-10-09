import { ApiError } from "@pstdio/pocketcoder-contracts";
import { type AuthStore, type PrincipalRow, principalWithinAuthority } from "@pstdio/pocketcoder-runtime-core";
import type { Context } from "hono";
import type { AppEnv } from "../http/middleware";

export async function managedPrincipal(context: Context<AppEnv>, store: AuthStore, id: string) {
  // No implicit admin bypass: delegated recovery must name its exact targets.
  if (!context.get("managedPrincipalIds").includes(id)) throw new ApiError("principal.not_found", "Unknown principal.");
  const principal = await store.getPrincipal(id);
  if (!principal) throw new ApiError("principal.not_found", "Unknown principal.");
  return principal;
}

export function principalVisible(context: Context<AppEnv>, principal: PrincipalRow) {
  return principalWithinAuthority(
    { scopes: context.get("scopes"), templateNames: context.get("principal").templateNames },
    principal,
  );
}

export async function keyAdministrationPrincipal(context: Context<AppEnv>, store: AuthStore, id: string) {
  if (!context.get("scopes").includes("admin") && context.get("managedPrincipalIds").length) {
    return managedPrincipal(context, store, id);
  }
  const principal = await store.getPrincipal(id);
  if (!principal || !principalVisible(context, principal))
    throw new ApiError("principal.not_found", "Unknown principal.");
  return principal;
}
