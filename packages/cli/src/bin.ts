#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const target = `${process.platform}-${process.arch}`;
const targets = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];
if (!targets.includes(target)) throw new Error(`Unsupported PocketCoder platform: ${target}`);
const executable = fileURLToPath(new URL(`./native/${target}/pocketcoder`, import.meta.url));
const child = spawn(executable, process.argv.slice(2), { stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
child.on("error", (error) => {
  console.error(`pcd: ${error.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
