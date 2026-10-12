import { existsSync } from "node:fs";
import { join } from "node:path";

const directory = process.env.PC_DISCOVERY_FIXTURE;
const docker = process.env.PC_DISCOVERY_DOCKER;
if (!directory || !docker) throw new Error("Missing real discovery fixture tools.");
const args = process.argv.slice(2);
if (args[0] === "ps" && args.includes("label=pocketcoder.workspace")) {
  await Bun.write(
    join(directory, "discovery.json"),
    JSON.stringify({
      epochMs: Date.now(),
      pid: process.pid,
      databaseExists: existsSync(join(directory, "data", "db", "PG_VERSION")),
      keysExist: existsSync(join(directory, "data", "keys", "auth-pepper")),
    }),
  );
  while (!existsSync(join(directory, "release"))) await Bun.sleep(10);
}
const child = Bun.spawn([docker, ...args], { stdout: "inherit", stderr: "inherit" });
if (args[0] === "ps" && args.includes("label=pocketcoder.workspace"))
  await Bun.write(
    join(directory, "discovery-child.json"),
    JSON.stringify({ epochMs: Date.now(), wrapperPid: process.pid, childPid: child.pid }),
  );
const exit = await child.exited;
if (args[0] === "ps" && args.includes("label=pocketcoder.workspace"))
  await Bun.write(
    join(directory, "discovery-settled.json"),
    JSON.stringify({ epochMs: Date.now(), pid: process.pid, childPid: child.pid, exit }),
  );
process.exitCode = exit;
