export async function command(args: string[], capture = false) {
  const child = Bun.spawn(args, {
    stdout: capture ? "pipe" : "inherit",
    stderr: "inherit",
    env: { ...process.env, NX_LOAD_DOT_ENV_FILES: "false", NX_DAEMON: "false" },
  });
  const output = capture ? await new Response(child.stdout).text() : "";
  const code = await child.exited;
  if (code !== 0) throw new Error(`${args.join(" ")} exited ${code}`);
  return output;
}
