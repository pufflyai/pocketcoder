import { randomUUID } from "node:crypto";
import type { TemplateManifest } from "@pstdio/pocketcoder-contracts";
import { PocketCoderClient } from "@pstdio/pocketcoder-sdk";
import { connectBrowser } from "./browser-client";
import { connectDesktop } from "./desktop-client";

export async function probeKubernetesImageDisplay(
  baseUrl: string,
  key: string,
  image: string,
  mode: "desktop" | "browser",
  runtimeDiagnostics: (workspaceId: string) => Promise<unknown>,
) {
  const template = (await Bun.file(`examples/templates/${mode}.json`).json()) as TemplateManifest;
  template.spec.image = image;
  template.spec.resources.ephemeralStorage = "128Mi";
  if (mode === "browser") {
    const fixture =
      "await import('/opt/pocketcoder/echo-harness.ts');Bun.serve({hostname:'127.0.0.1',port:3000,fetch(){return new Response('<h1>Candidate browser on Kubernetes</h1>',{headers:{'content-type':'text/html'}})}})";
    template.spec.harness = { command: ["bun", "/opt/pocketcoder/browser-harness.ts", "bun", "-e", fixture], env: {} };
  }
  const client = new PocketCoderClient({ baseUrl, apiKey: key });
  await client.raw("/v1/templates", { method: "POST", body: JSON.stringify({ manifest: template }) });
  const workspace = await client.workspaces.create({ templateName: mode, externalId: `candidate-${randomUUID()}` });
  let socket: WebSocket | undefined;
  try {
    await client.workspaces.waitForReady(workspace, 30_000);
    const origin = new URL((await client.displays.open(workspace.id, true)).url);
    const response = await fetch(`${baseUrl}${origin.pathname}${origin.search}`, {
      redirect: "manual",
      headers: { host: origin.host },
    });
    if (response.status !== 303) throw new Error("Kubernetes display token exchange failed");
    const cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
    if (mode === "desktop") {
      const desktop = await connectDesktop(baseUrl, origin, cookie);
      socket = desktop.socket;
      await desktop.capture();
    } else {
      const browser = await connectBrowser(baseUrl, origin, cookie);
      socket = browser.socket;
      browser.send({ action: "navigate", url: "http://127.0.0.1:3000" });
      await browser.capture();
    }
    const runtime = mode === "desktop" ? await runtimeDiagnostics(workspace.id) : undefined;
    return { mode, image, result: "passed", viewer: "trusted pixels over authenticated supervisor", runtime };
  } catch (error) {
    console.log("Workspace harness logs", await client.logs.list(workspace.id, { limit: 1000 }));
    console.log(await runtimeDiagnostics(workspace.id));
    throw error;
  } finally {
    socket?.close();
    await client.workspaces.cancel(workspace.id);
  }
}
