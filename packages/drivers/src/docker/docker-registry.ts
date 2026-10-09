import type { RegistryCredential } from "../registry/registry";
import { localDockerSocket, registryImageRequest } from "./docker-registry-client";

export async function pullPrivateImage(bin: string, image: string, credential: RegistryCredential) {
  if (!/^[^\s@]+@sha256:[a-f0-9]{64}$/.test(image)) throw new Error("Private workspace images require a pinned digest");
  const socketPath = await localDockerSocket(bin);
  try {
    await registryImageRequest(socketPath, `/images/create?${new URLSearchParams({ fromImage: image })}`, credential);
  } catch {
    throw new Error("Private workspace image pull failed");
  }
}
