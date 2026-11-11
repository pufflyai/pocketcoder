import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { PocketCoderClient } from "@pstdio/pocketcoder-sdk";
import { loadConfig } from "@pstdio/pocketcoder-server/config";
import { startPocketCoderServer } from "@pstdio/pocketcoder-server/lifecycle";
import { bootstrapExampleOwner } from "../e2e/administration";
import { localInputEnvironment } from "./input-environment";
import { resolveLocalPiOptions } from "./options";
import { preparePiRuntime } from "./runtime";
import { startLocalPiGateway } from "./start-gateway";

const options = resolveLocalPiOptions();
const gateway = await startLocalPiGateway(options);
const prepared = await preparePiRuntime({ ...options, gatewayUrl: `http://host.docker.internal:${gateway.port}/v1` });
const stateRoot = resolve(homedir(), ".local/share/pocketcoder/local-pi");
await mkdir(stateRoot, { recursive: true, mode: 0o700 });
async function hostSecret(name: string) {
  const path = resolve(stateRoot, name);
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const value = randomBytes(32).toString("base64url");
    await writeFile(path, value, { mode: 0o600 });
    return value;
  }
}
const pepper = await hostSecret("pepper");
const secretKey = await hostSecret("vault-key");
const caFile = resolve(stateRoot, "issuer-ca.pem");
await writeFile(caFile, gateway.ca, { mode: 0o600 });
const dataDir = resolve(stateRoot, "data");
const token = await bootstrapExampleOwner(dataDir, pepper, new Date(Date.now() + 2 * 60 * 60_000));
const server = await startPocketCoderServer(
  loadConfig({
    ...process.env,
    POCKETCODER_DIR: dataDir,
    ...localInputEnvironment(stateRoot),
    POCKETCODER_AUTH_PEPPER: pepper,
    POCKETCODER_SECRET_KEY: secretKey,
    POCKETCODER_ISSUER_CA_FILE: caFile,
    POCKETCODER_TEMPLATE_DIR: undefined,
  }),
);
const client = new PocketCoderClient({ baseUrl: server.url, apiKey: token });
await client.secrets.put("pi-gateway", { type: "runtime-issuer", value: gateway.config });
await client.templates.publish(await Bun.file(prepared.templatePath).json());
console.log(`Native Pi ready: ${prepared.templateName}@${prepared.templateVersion}`);
console.log(`PocketCoder API: ${server.url}`);
console.log("Use your host operator key with pcd workspaces create, attach, and chat.");
await new Promise<void>((done, reject) => {
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    server
      .stop()
      .then(() => gateway.close())
      .then(done, reject);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
});
