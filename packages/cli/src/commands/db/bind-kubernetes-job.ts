import { bindKubernetesJob, postgresSqlClient } from "@pstdio/pocketcoder-db";
import { KubernetesDriver } from "@pstdio/pocketcoder-drivers";
import { databaseLocation } from "@pstdio/pocketcoder-server/store-config";
import { SQL } from "bun";
import type { Argv } from "yargs";
import { addAction } from "../command";

export function addKubernetesBindingCommand(commands: Argv) {
  addAction(
    commands,
    "bind-kubernetes-job",
    "Bind an operator-verified original Job UID to a legacy provider",
    (command) =>
      command
        .option("kind", { choices: ["workspace", "warm-runtime"] as const, demandOption: true })
        .option("id", { type: "string", demandOption: true })
        .option("namespace", { type: "string", demandOption: true })
        .option("job-uid", {
          type: "string",
          demandOption: true,
          description: "Original Job UID verified from trusted records; never infer it from a same-name replacement",
        }),
    async (flags) => {
      const request = {
        kind: flags.kind as "workspace" | "warm-runtime",
        id: flags.id as string,
        namespace: flags.namespace as string,
        jobUid: flags["job-uid"] as string,
      };
      const { databaseUrl, databaseSchema } = databaseLocation(process.env);
      const sql = new SQL(databaseUrl, { max: 1 });
      try {
        const driver = new KubernetesDriver({ namespace: request.namespace });
        await bindKubernetesJob(postgresSqlClient(sql), databaseSchema, request, async (binding) => {
          const poolId = binding.kind === "warm-runtime" ? binding.id : binding.providerRef.poolRuntimeId;
          const provider =
            typeof poolId === "string"
              ? (await driver.listWarm()).find((item) => item.runtimeId === poolId)
              : (await driver.list()).find((item) => item.workspaceId === binding.id);
          if (
            provider?.ref.id !== binding.providerRef.id ||
            provider?.ref.jobUid !== request.jobUid ||
            provider.templateDigest !== binding.templateDigest
          )
            throw new Error("Original Kubernetes Job UID, name, owner label or template digest does not match");
        });
        console.log(
          `bound ${request.kind} ${request.id} to Job UID ${request.jobUid}; normal controller cleanup is still required`,
        );
      } finally {
        await sql.end();
      }
    },
  );
}
