import { spawn } from "node:child_process";
import { chmod, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { waitFor } from "../e2e/local-process";
import { connectionFile, readConnection, sessionControl } from "./connection";
import { isolatedEnvironment, requiredEnvironment } from "./environment";
import { resumeInvocation } from "./launch";

async function startSession(directory: string, idleSeconds: number, checkModel: boolean) {
  let connection = await readConnection(directory);
  if (!connection) {
    const env = isolatedEnvironment();
    if (!checkModel) {
      for (const name of ["OPENAI_API_KEY", "OPENAI_MODEL"]) env[name] = requiredEnvironment(name);
      for (const name of ["OPENAI_ORGANIZATION", "OPENAI_PROJECT"]) {
        if (process.env[name]) env[name] = process.env[name];
      }
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const logPath = join(directory, "daemon.log");
    const log = await open(logPath, "w", 0o600);
    console.error(`Starting the isolated session. Build and server log: ${logPath}`);
    const daemon = spawn(
      process.execPath,
      [
        "--no-env-file",
        join(import.meta.dir, "daemon.ts"),
        directory,
        String(idleSeconds),
        ...(checkModel ? ["--check-model"] : []),
      ],
      {
        env,
        detached: true,
        stdio: ["ignore", log.fd, log.fd],
      },
    );
    await log.close();
    try {
      await waitFor(
        async () => {
          if (daemon.exitCode !== null) throw new Error(`Isolated startup failed. See ${logPath}`);
          connection = await readConnection(directory);
          return !!connection;
        },
        600_000,
        "isolated startup",
      );
    } catch (error) {
      daemon.kill("SIGTERM");
      throw error;
    } finally {
      daemon.unref();
    }
  }
  if (!connection) throw new Error("Isolated session did not start");
  return connection;
}

export async function launchSession(
  directory: string,
  idleSeconds: number,
  rpc: boolean,
  checkModel: boolean,
) {
  const connection = await startSession(directory, idleSeconds, checkModel);
  const response = await sessionControl(connection, "attach");
  const workspace = (await response.json()) as { id: string };
  const invocation = resumeInvocation({ ...connection, workspaceId: workspace.id, check: rpc });
  console.error(
    `Connected to workspace ${workspace.id.slice(0, 8)}. Type /quit, then run this command again to reconnect.`,
  );
  console.error(`Saved until ${connection.expiresAt}. Use --stop to delete this test session.`);
  const child = Bun.spawn(invocation.command, {
    env: invocation.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const interrupt = () => child.kill("SIGTERM");
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, interrupt);
  try {
    const code = await child.exited;
    console.error("Saving workspace before disconnecting...");
    await sessionControl(connection, "detach");
    console.error("Session saved. Run the same command to reconnect.");
    return code;
  } finally {
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.removeListener(signal, interrupt);
  }
}

export async function stopSession(directory: string) {
  const connection = await readConnection(directory);
  if (!connection) {
    console.log("No isolated session is running.");
    return;
  }
  await sessionControl(connection, "stop");
  await waitFor(
    async () => !(await Bun.file(connectionFile(directory)).exists()),
    120_000,
    "isolated cleanup",
  );
  console.log("Removed the isolated session, database and checkpoints.");
}
