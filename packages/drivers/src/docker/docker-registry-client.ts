import { type IncomingMessage, request } from "node:http";
import type { RegistryCredential } from "../registry/registry";
import { runDocker } from "./docker-command";

export async function localDockerSocket(bin: string) {
  const context = process.env.DOCKER_CONTEXT || (await runDocker(bin, ["context", "show"]));
  const [description] = JSON.parse(await runDocker(bin, ["context", "inspect", context]));
  const endpoint =
    process.env.DOCKER_HOST && !process.env.DOCKER_CONTEXT
      ? process.env.DOCKER_HOST
      : (description.Endpoints.docker.Host as string);
  if (!endpoint.startsWith("unix:///")) throw new Error("Private workspace pulls require a local Docker socket");
  return endpoint.slice("unix://".length);
}

// Send auth only to the selected local daemon. No config file survives a controller crash.
export async function registryImageRequest(socketPath: string, path: string, credential: RegistryCredential) {
  // Docker decodes padded URL-safe base64; Bun's base64url output omits padding.
  const auth = Buffer.from(
    JSON.stringify({ username: credential.username, password: credential.password, serveraddress: credential.server }),
  )
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_");
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const client = request(
      { socketPath, method: "POST", path, agent: false, headers: { "X-Registry-Auth": auth } },
      resolve,
    );
    client.on("error", reject);
    client.end();
  });
  let pending = "";
  let digest: string | undefined;
  function progress(line: string) {
    if (!line.trim()) return;
    if (Buffer.byteLength(line) > 65536) throw new Error("Registry progress exceeds the limit");
    const entry = JSON.parse(line);
    // Docker can report a registry failure in a successful HTTP response.
    if (entry.error || entry.errorDetail) throw new Error("Registry image request failed");
    if (typeof entry.status === "string") digest = entry.status.match(/digest: (sha256:[a-f0-9]{64})/)?.[1] ?? digest;
    if (typeof entry.aux?.Digest === "string" && /^sha256:[a-f0-9]{64}$/.test(entry.aux.Digest))
      digest = entry.aux.Digest;
  }
  try {
    if (response.statusCode !== 200) throw new Error("Registry image request failed");
    response.setEncoding("utf8");
    for await (const chunk of response) {
      pending += chunk;
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        progress(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
      if (Buffer.byteLength(pending) > 65536) throw new Error("Registry progress exceeds the limit");
    }
    progress(pending);
    return digest;
  } finally {
    response.destroy();
  }
}
