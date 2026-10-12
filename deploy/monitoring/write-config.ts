import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { monitoringConfig } from "./config";

const [input, directory] = process.argv.slice(2);
if (!input || !directory) throw new Error("Usage: bun deploy/monitoring/write-config.ts input.json output-directory");
const config = monitoringConfig(await Bun.file(input).json());
await mkdir(directory, { recursive: true, mode: 0o700 });
for (const [name, value] of Object.entries(config))
  await writeFile(join(directory, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
console.log("Wrote Prometheus rules and scrape configuration, and Alertmanager receiver configuration.");
