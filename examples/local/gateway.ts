import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { resolveLocalPiOptions } from "./options";
import { startLocalPiGateway } from "./start-gateway";

const gateway = await startLocalPiGateway(resolveLocalPiOptions());
const directory = resolve(homedir(), ".local/share/pocketcoder/local-pi");
await mkdir(directory, { recursive: true, mode: 0o700 });
const configPath = resolve(directory, "issuer.json");
const caPath = resolve(directory, "issuer-ca.pem");
await writeFile(configPath, JSON.stringify({ type: "runtime-issuer", value: gateway.config }), { mode: 0o600 });
await writeFile(caPath, gateway.ca, { mode: 0o600 });
console.log(`Workspace gateway listening on ${gateway.url}`);
console.log(`Host issuer configuration: ${configPath}`);
console.log(`Controller issuer CA: ${caPath}`);
await new Promise<void>((done, reject) => {
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    gateway
      .close()
      .then(() => rm(configPath, { force: true }))
      .then(done, reject);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
});
