import { resolve } from "node:path";

interface CliResult {
  exitCode: number;
  output: string;
}

interface RunCliOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  keepStdinOpen?: boolean;
}

const pocketcoderEnvironment = [
  "POCKETCODER_AUTH_PEPPER",
  "POCKETCODER_DATABASE_SCHEMA",
  "POCKETCODER_DATABASE_URL",
  "POCKETCODER_HOST",
  "POCKETCODER_KEY",
  "POCKETCODER_PORT",
  "POCKETCODER_STATE_DIR",
  "POCKETCODER_STORE",
  "POCKETCODER_TEMPLATE_DIR",
  "POCKETCODER_URL",
];

export function freePort(): number {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = Number(probe.port);
  probe.stop(true);
  return port;
}

export async function runCli(
  args: readonly string[],
  options: RunCliOptions = {},
): Promise<CliResult> {
  const env: Record<string, string | undefined> = { ...Bun.env, NO_COLOR: "1" };
  delete env.FORCE_COLOR;
  for (const key of pocketcoderEnvironment) delete env[key];
  Object.assign(env, options.env);
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", resolve(import.meta.dir, "index.ts"), ...args],
    {
      cwd: options.cwd ?? resolve(import.meta.dir, ".."),
      env,
      ...(options.keepStdinOpen ? { stdin: "pipe" } : {}),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, output: `${stdout}${stderr}` };
}
