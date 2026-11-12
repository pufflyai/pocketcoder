import { prepareStorage } from "./bootstrap/prepare-storage";
import { publishFileCommand } from "./sessions/publication-command";
import { serveSessions } from "./sessions/serve";
import { supervise } from "./supervisor";

// pocketcoder-supervisor CLI. `supervise` is the PID 1 entrypoint declared by
// template commands. Service commands select declared workspace processes.

function usage(): never {
  console.error(
    "usage: pocketcoder-supervisor supervise --launch-input <path> | service start <name> <start-id> | service stop|status <name>",
  );
  process.exit(64);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "session") {
    await sessionCommand(rest);
    return;
  }
  if (command === "service") {
    const [action, name, startId] = rest;
    if (!action || !["start", "stop", "status"].includes(action) || !name || !/^[a-z][a-z0-9-]{0,62}$/.test(name))
      usage();
    const response = await fetch(`http://localhost/${name}/${action}`, {
      unix: process.env.POCKETCODER_SERVICES_SOCKET ?? "/run/pocketcoder/services/services.sock",
      method: "POST",
      ...(action === "start" ? { body: JSON.stringify({ startId }) } : {}),
    });
    if (!response.ok) throw new Error(`Workspace service ${action} refused (${response.status})`);
    console.log(await response.text());
    return;
  }
  if (command === "prepare-storage") {
    prepareStorage(JSON.parse(rest[0] ?? "null"));
    return;
  }
  if (command !== "supervise") usage();
  let inputPath = "/run/pocketcoder/input";
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === "--launch-input") {
      const value = rest[i + 1];
      if (!value) usage();
      inputPath = value;
      i += 1;
    }
  }
  const code = await supervise(inputPath);
  process.exit(code);
}

async function sessionCommand([action, ...args]: string[]) {
  if (action === "publish-file") return publishFileCommand(args);
  if (action !== "serve") usage();
  serveSessions(args);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`pocketcoder-supervisor: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
