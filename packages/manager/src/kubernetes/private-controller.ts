import type { Account } from "../database/store";
import type { kube } from "./command";

export async function privateControllerRequest(command: typeof kube, account: Account, path: string, body?: unknown) {
  const deployment = JSON.parse(
    await command(["-n", account.namespace, "get", "deployment", "controller", "-o", "json"]),
  );
  if (deployment.metadata.labels?.["pocketcoder.dev/account"] !== account.id)
    throw new Error("Controller identity differs.");
  const timeout = path === "/v1/monitoring" ? 5000 : 120000;
  const script =
    "const h=await import('node:http');const i=JSON.parse(process.argv[1]);const body=i.body===undefined?undefined:JSON.stringify(i.body);const value=await new Promise((resolve,reject)=>{const r=h.request({socketPath:'/private/pc_data/admin.sock',path:i.path,method:body===undefined?'GET':'POST',headers:{'content-type':'application/json'}},s=>{let b='';s.on('data',v=>b+=v);s.on('end',()=>s.statusCode>=200&&s.statusCode<300?resolve(b):reject(Error('Private controller request pending')))});r.on('error',reject);r.setTimeout(i.timeout,()=>r.destroy(Error('Private controller timeout')));r.end(body)});console.log(value)";
  return JSON.parse(
    await command([
      "-n",
      account.namespace,
      "exec",
      ...(path === "/v1/monitoring" ? ["--pod-running-timeout=5s"] : []),
      "deployment/controller",
      "-c",
      "controller",
      "--",
      "bun",
      "-e",
      script,
      JSON.stringify({ path, body, timeout }),
    ]),
  ) as unknown;
}
