#!/usr/bin/env node
import { spawn } from "node:child_process";
import { resolvePiInvocation } from "./launch";

function main(): void {
  let invocation: ReturnType<typeof resolvePiInvocation>;
  try {
    invocation = resolvePiInvocation({ argv: process.argv.slice(2) });
  } catch (error) {
    console.error(`pocketcoder-remote: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  const child = spawn(invocation.command, invocation.args, {
    stdio: "inherit",
    env: invocation.env,
  });
  child.on("error", (error) => {
    console.error(`pocketcoder-remote: failed to launch pi: ${error.message}`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    process.exit(code ?? (signal ? 1 : 0));
  });
}

main();
