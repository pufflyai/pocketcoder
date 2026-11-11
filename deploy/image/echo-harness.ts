// The echo image uses PocketCoder's native execution producer.
const child = Bun.spawn(["/usr/local/bin/pocketcoder-supervisor", "session", "serve", "echo"], {
  stdin: "ignore",
  stdout: "inherit",
  stderr: "inherit",
});
process.on("SIGTERM", () => child.kill("SIGTERM"));
process.exit(await child.exited);
