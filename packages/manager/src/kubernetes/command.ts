export async function kube(args: string[], input?: string) {
  const child = Bun.spawn(["kubectl", "--request-timeout=30s", ...args], {
    env: { ...process.env },
    stdin: input === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (input !== undefined && child.stdin) {
    child.stdin.write(input);
    child.stdin.end();
  }
  const timer = setTimeout(() => child.kill(), 130_000);
  try {
    const [out, code] = await Promise.all([
      new Response(child.stdout).text(),
      child.exited,
      new Response(child.stderr).text(),
    ]);
    if (code !== 0 || out.length > 2 * 1024 ** 2) throw new Error("Kubernetes account command failed");
    return out.trim();
  } finally {
    clearTimeout(timer);
  }
}
