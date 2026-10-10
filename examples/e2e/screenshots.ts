import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { connectBrowser } from "./browser-client";
import { startDisplayDemo } from "./display-runtime";

const output = resolve(process.argv[2] ?? "/tmp/pocketcoder-screenshots");
await mkdir(output, { recursive: true, mode: 0o700 });
for (const mode of ["desktop", "browser"] as const) {
  const demo = await startDisplayDemo(
    mode,
    (template) => {
      if (mode === "browser")
        template.spec.harness.command = [
          "bun",
          "/opt/pocketcoder/browser-harness.ts",
          "bun",
          "-e",
          "await import('/opt/pocketcoder/echo-harness.ts');Bun.serve({hostname:'127.0.0.1',port:3000,fetch:()=>new Response('<style>body{background:#24496a;color:white;font:32px sans-serif}</style><h1>Private browser screenshot</h1>',{headers:{'content-type':'text/html'}})})",
        ];
    },
    {
      POCKETCODER_MAX_RETAINED_BYTES: "12648448",
      POCKETCODER_MAX_RETAINED_BYTES_PER_PRINCIPAL: "12648448",
    },
  );
  let socket: WebSocket | undefined;
  try {
    if (mode === "browser") {
      const session = await demo.open(true);
      const browser = await connectBrowser(demo.baseUrl, session.url, session.cookie);
      socket = browser.socket;
      browser.send({ action: "navigate", url: "http://127.0.0.1:3000" });
      await browser.capture();
      await Bun.sleep(1000);
    }
    const resource = await demo.client.displays.capture(demo.workspace.id);
    const response = await demo.client.outputs.download(demo.workspace.id, resource.id);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length !== resource.bytes || bytes.length < 1000) throw new Error("Real screenshot bytes are missing.");
    await Bun.write(join(output, `${mode}.png`), bytes);
    const path = `/v1/workspaces/${demo.workspace.id}/outputs/${resource.id}/content`;
    if ((await fetch(`${demo.baseUrl}${path}`)).status !== 401) throw new Error("Screenshot leaked without authority.");
    const quota = await demo.client.displays.capture(demo.workspace.id).then(
      () => false,
      (error) => error.code === "storage.capacity_exhausted",
    );
    if (!quota) throw new Error("Screenshot quota was not enforced.");
    const operation = await demo.client.workspaces.purge(demo.workspace.id, randomUUID());
    const deadline = Date.now() + 10_000;
    while ((await demo.client.operations.get(operation.id)).state !== "succeeded") {
      if (Date.now() > deadline) throw new Error("Screenshot purge did not finish.");
      await Bun.sleep(50);
    }
    if ((await demo.client.raw(path)).status !== 404) throw new Error("Purge left screenshot bytes readable.");
    console.log(
      JSON.stringify({
        mode,
        bytes: resource.bytes,
        digest: resource.digest,
        file: join(output, `${mode}.png`),
        private: true,
        quota: true,
        purge: true,
      }),
    );
  } finally {
    socket?.close();
    await demo.close();
  }
}
