#!/usr/bin/env bun

import { createCli } from "./command/command-tree";

export { createCli } from "./command/command-tree";

async function main() {
  await createCli(process.argv.slice(2)).parseAsync();
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`pcd: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  });
}
