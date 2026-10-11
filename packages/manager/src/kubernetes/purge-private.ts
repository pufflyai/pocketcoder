import { z } from "zod";
import type { PurgeTarget } from "../purge/provider-types";
import type { kube } from "./command";

export async function privatePurgeRequest(
  command: typeof kube,
  target: PurgeTarget,
  podUid: string,
  operationId: string,
) {
  async function controller() {
    const result = z
      .object({
        items: z.array(
          z.object({
            metadata: z.object({ name: z.string(), uid: z.uuid(), labels: z.record(z.string(), z.string()) }),
          }),
        ),
      })
      .parse(JSON.parse(await command(["-n", target.namespace, "get", "pods", "-o", "json"])));
    const pod = result.items.find((entry) => entry.metadata.uid === podUid);
    if (
      !pod ||
      pod.metadata.labels["pocketcoder.dev/account"] !== target.id ||
      pod.metadata.labels["pocketcoder.dev/role"] !== "controller"
    )
      throw new Error("Private purge controller identity differs.");
    return pod.metadata.name;
  }
  const name = await controller();
  const script =
    "const h=await import('node:http');const id=JSON.parse(process.argv[1]);const result=await new Promise((resolve,reject)=>{const r=h.request({socketPath:'/private/pc_data/admin.sock',path:'/v1/account/purge',method:'POST',headers:{'content-type':'application/json'}},s=>{let b='';s.on('data',v=>b+=v);s.on('end',()=>s.statusCode===200?resolve(b):reject(Error('Private purge pending')))});r.on('error',reject);r.setTimeout(120000,()=>r.destroy(Error('Private purge timeout')));r.end(JSON.stringify({operation_id:id}))});console.log(result)";
  const result = JSON.parse(
    await command([
      "-n",
      target.namespace,
      "exec",
      name,
      "-c",
      "controller",
      "--",
      "bun",
      "-e",
      script,
      JSON.stringify(operationId),
    ]),
  ) as unknown;
  if ((await controller()) !== name) throw new Error("Private purge controller changed.");
  return result;
}
