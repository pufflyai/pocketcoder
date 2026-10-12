import { randomUUID } from "node:crypto";
import type { createKubernetesCluster } from "./kubernetes-cluster";
import { command, waitFor } from "./local-process";
import { offNodeFixture } from "./off-node-fixture";

const image = "oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61";
const flag = "/tmp/journal-write-fault";
// Keep real purge reads available so the fault reaches the enforced mutation's journal write.
const script = `
const upstream = process.argv[1];
Bun.serve({hostname:'0.0.0.0',port:9000,async fetch(request) {
  if(request.method==='PUT'&&await Bun.file('${flag}').exists())
    return new Response('Owned storage write fault',{status:503});
  const url=new URL(request.url);
  const headers=new Headers(request.headers);
  for(const name of ['connection','transfer-encoding','content-length']) headers.delete(name);
  return fetch(upstream+url.pathname+url.search,{method:request.method,headers,
    body:['GET','HEAD'].includes(request.method)?undefined:await request.arrayBuffer(),redirect:'manual'});
}});
`;

export async function storageWriteFaultProxy(upstream: string, network = "kind") {
  const name = `pc53-storage-${randomUUID()}`;
  try {
    await command(
      [
        "docker",
        "run",
        "-d",
        "--name",
        name,
        "--network",
        network,
        "-p",
        "127.0.0.1::9000",
        image,
        "bun",
        "-e",
        script,
        upstream,
      ],
      { quiet: true },
    );
    const { stdout: address } = await command(
      ["docker", "inspect", "--format", `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`, name],
      { quiet: true },
    );
    const { stdout: published } = await command(["docker", "port", name, "9000/tcp"], { quiet: true });
    await waitFor(
      async () =>
        fetch(`http://${published}/health`)
          .then((response) => response.ok)
          .catch(() => false),
      10_000,
      "owned storage write proxy readiness",
    );
    return {
      endpoint: `http://${address}:9000`,
      hostEndpoint: `http://${published}`,
      async failWrites(enabled: boolean) {
        const change = enabled
          ? `await Bun.write('${flag}','1')`
          : `await (await import('node:fs/promises')).unlink('${flag}')`;
        await command(["docker", "exec", name, "bun", "-e", change], { quiet: true });
      },
      close: () => command(["docker", "rm", "-f", name], { quiet: true }),
    };
  } catch (error) {
    await command(["docker", "rm", "-f", name], { quiet: true }).catch(() => {});
    throw error;
  }
}

export async function monitoringStorageFixture() {
  const storage = await offNodeFixture();
  let proxy: Awaited<ReturnType<typeof storageWriteFaultProxy>> | undefined;
  return {
    async configure(cluster: Awaited<ReturnType<typeof createKubernetesCluster>>) {
      const config = await storage.configure(cluster);
      proxy = await storageWriteFaultProxy(config.storage.endpoint);
      config.storage.endpoint = proxy.endpoint;
      return config;
    },
    async failWrites(enabled: boolean) {
      if (!proxy) throw new Error("Owned journal storage proxy is missing");
      await proxy.failWrites(enabled);
    },
    async close() {
      await proxy?.close();
      await storage.close();
    },
  };
}
