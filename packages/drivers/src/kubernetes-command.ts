export async function kubectl(
  bin: string,
  namespace: string,
  args: string[],
  input?: string,
): Promise<string> {
  const proc = Bun.spawn([bin, "--namespace", namespace, "--request-timeout=30s", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    ...(input === undefined ? {} : { stdin: "pipe" }),
  });
  if (input !== undefined && proc.stdin) {
    proc.stdin.write(input);
    proc.stdin.end();
  }
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`kubectl ${args[0]} failed (${code}): ${stderr.trim().slice(0, 500)}`);
  }
  return stdout.trim();
}

export function resourceName(workspaceId: string): string {
  return `pocketcoder-ws-${workspaceId}`;
}

export function isKubernetesName(value: string): boolean {
  return value.length <= 253 && /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/.test(value);
}
