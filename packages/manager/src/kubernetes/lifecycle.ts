import { z } from "zod";
import type { Account } from "../database/store";
import type { kube } from "./command";

const LifecycleResult = z.object({
  state: z.enum(["ready", "suspended", "suspending", "resuming"]),
  operation_state: z.enum(["pending", "succeeded"]),
  compute_proof: z.record(z.string(), z.unknown()).optional(),
});
const Inventory = z.object({
  items: z.array(
    z.object({
      metadata: z.object({
        labels: z.record(z.string(), z.string()).optional(),
        ownerReferences: z.array(z.object({ kind: z.string() })).optional(),
      }),
    }),
  ),
});
export function kubernetesLifecycle(command: typeof kube) {
  async function deployment(account: Account) {
    const record = JSON.parse(
      await command(["-n", account.namespace, "get", "deployment", "controller", "-o", "json"]),
    );
    if (record.metadata.labels?.["pocketcoder.dev/account"] !== account.id)
      throw new Error("Controller identity mismatch");
    return record;
  }
  async function inventory(account: Account, controllersAllowed: boolean) {
    const jobs = Inventory.parse(JSON.parse(await command(["-n", account.namespace, "get", "jobs", "-o", "json"])));
    const pods = Inventory.parse(JSON.parse(await command(["-n", account.namespace, "get", "pods", "-o", "json"])));
    if (jobs.items.length) throw new Error("Account jobs remain");
    for (const pod of pods.items) {
      const controller =
        controllersAllowed &&
        pod.metadata.labels?.["pocketcoder.dev/account"] === account.id &&
        pod.metadata.labels?.["pocketcoder.dev/role"] === "controller" &&
        pod.metadata.ownerReferences?.some((owner) => owner.kind === "ReplicaSet");
      if (!controller) throw new Error("Account compute remains");
    }
  }
  return {
    async perform(account: Account, kind: "suspend" | "resume", requestId: string) {
      await deployment(account);
      const script =
        "const u=await import('node:http');const input=JSON.parse(process.argv[1]);const result=await new Promise((resolve,reject)=>{const r=u.request({socketPath:'/private/pc_data/admin.sock',path:'/v1/account/'+input.kind,method:'POST',headers:{'content-type':'application/json'}},s=>{let b='';s.on('data',v=>b+=v);s.on('end',()=>s.statusCode===200?resolve(b):reject(Error('Lifecycle pending')))});r.on('error',reject);r.end(JSON.stringify({request_id:input.id}))});console.log(result)";
      const result = LifecycleResult.parse(
        JSON.parse(
          await command([
            "-n",
            account.namespace,
            "exec",
            "deployment/controller",
            "-c",
            "controller",
            "--",
            "bun",
            "-e",
            script,
            JSON.stringify({ kind, id: requestId }),
          ]),
        ),
      );
      const expected = kind === "suspend" ? "suspended" : "ready";
      if (result.state !== expected || result.operation_state !== "succeeded")
        throw new Error("Controller lifecycle is pending");
      return result;
    },
    async scaleDown(account: Account) {
      const current = await deployment(account);
      await inventory(account, true);
      if (current.spec.replicas !== 0)
        await command(["-n", account.namespace, "scale", "deployment/controller", "--replicas=0"]);
      await command([
        "-n",
        account.namespace,
        "wait",
        "--for=delete",
        "pod",
        "-l",
        `pocketcoder.dev/account=${account.id},pocketcoder.dev/role=controller`,
        "--timeout=120s",
      ]);
      await inventory(account, false);
    },
    async scaleUp(account: Account) {
      const current = await deployment(account);
      if (current.spec.replicas !== 1)
        await command(["-n", account.namespace, "scale", "deployment/controller", "--replicas=1"]);
      await command(["-n", account.namespace, "rollout", "status", "deployment/controller", "--timeout=120s"]);
    },
  };
}
