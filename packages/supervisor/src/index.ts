import { supervise } from "./supervisor";

// pocketcoder-supervisor CLI. `supervise` is the PID 1 entrypoint declared by
// template commands; future subcommands (e.g. pi-adapter) hang off the same
// binary.

function usage(): never {
  console.error("usage: pocketcoder-supervisor supervise --launch-input <path>");
  process.exit(64);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
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

if (import.meta.main) {
  main().catch((err) => {
    console.error(`pocketcoder-supervisor: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
