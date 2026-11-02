import { resourceName } from "./kubernetes-command";

type Run = (args: string[]) => Promise<string>;

export async function purgeWorkspaceSecrets(run: Run, workspaceId: string) {
  const name = resourceName(workspaceId);
  await run([
    "delete",
    "secret",
    `${name}-input`,
    `${name}-egress`,
    `${name}-registry`,
    "--ignore-not-found",
    "--wait=true",
  ]);
}

export async function cleanupWorkspaceInput(run: Run, workspaceId: string) {
  const name = resourceName(workspaceId);
  await run(["delete", "secret", `${name}-input`, `${name}-registry`, "--ignore-not-found"]).catch(() => {});
}

export async function cleanupWarmInput(run: Run, runtimeId: string) {
  await run(["delete", "secret", `pocketcoder-pool-${runtimeId}-input`, "--ignore-not-found"]).catch(() => {});
}
