import type { Account } from "../database/store";
import type { kube } from "./command";

export async function privateControllerRequest(command: typeof kube, account: Account, path: string, body?: unknown) {
  const deployment = JSON.parse(
    await command(["-n", account.namespace, "get", "deployment", "controller", "-o", "json"]),
  );
  if (deployment.metadata.labels?.["pocketcoder.dev/account"] !== account.id)
    throw new Error("Controller identity differs.");
  const script =
    "const h=await import('node:http');const i=JSON.parse(process.argv[1]);const body=i.body===undefined?undefined:JSON.stringify(i.body);const value=await new Promise((resolve,reject)=>{const r=h.request({socketPath:'/private/pc_data/admin.sock',path:i.path,method:body===undefined?'GET':'POST',headers:{'content-type':'application/json'}},s=>{let b='';s.on('data',v=>b+=v);s.on('end',()=>s.statusCode>=200&&s.statusCode<300?resolve(b):reject(Error('Private controller request pending')))});r.on('error',reject);r.setTimeout(120000,()=>r.destroy(Error('Private controller timeout')));r.end(body)});console.log(value)";
  return JSON.parse(
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
      JSON.stringify({ path, body }),
    ]),
  ) as unknown;
}
