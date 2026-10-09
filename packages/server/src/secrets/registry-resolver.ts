import { ApiError } from "@pstdio/pocketcoder-contracts";
import type { createSecretVault } from "./secret-vault";

export function createRegistryResolver(vault: ReturnType<typeof createSecretVault>) {
  return async (reference: string, image: string) => {
    const config = await vault.resolve(reference.slice("secretRef:".length), "registry");
    const first = image.slice(0, image.indexOf("/"));
    const registry =
      image.includes("/") && (first.includes(".") || first.includes(":") || first === "localhost")
        ? first
        : "docker.io";
    if (config.type !== "registry" || config.value.server !== registry) {
      throw new ApiError("secret.unavailable", "Stored registry does not match the workspace image.");
    }
    return config.value;
  };
}
