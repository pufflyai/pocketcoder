// The reference file agent uses the same native producer as every other client.
const child = Bun.spawn(["/usr/local/bin/bun", "/opt/pocketcoder/supervisor.js", "session", "serve", "echo"], {
  stdin: "ignore",
  stdout: "inherit",
  stderr: "inherit",
});
process.once("SIGTERM", () => child.kill("SIGTERM"));
process.once("SIGINT", () => child.kill("SIGTERM"));
process.exit(await child.exited);
