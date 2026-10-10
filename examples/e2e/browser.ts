import { randomUUID } from "node:crypto";
import { PocketCoderClient } from "@pstdio/pocketcoder-sdk";
import { connectBrowser } from "./browser-client";
import { startDisplayDemo } from "./display-runtime";
import { command, waitFor } from "./local-process";
import { pauseBrowser } from "./paused-browser";

const page = `<!doctype html><style>body{background:#24496a;color:white;font:32px sans-serif}input{position:absolute;left:100px;top:100px;width:400px;height:50px;font:32px sans-serif}button{position:absolute;left:100px;top:200px;font:32px sans-serif}</style><h1>Browser control</h1><input id="text" oninput="fetch('/typed?value='+encodeURIComponent(this.value))"><button onclick="this.textContent='Clicked';fetch('/clicked')">Click me</button>`;
const detailed = `<html><body style="margin:0"><canvas width="1280" height="800"></canvas><script>const c=document.querySelector('canvas').getContext('2d');const p=c.createImageData(1280,800);let seed=7;for(let i=0;i<p.data.length;i+=4){seed=(seed*1664525+1013904223)>>>0;p.data[i]=seed&255;p.data[i+1]=(seed>>>8)&255;p.data[i+2]=(seed>>>16)&255;p.data[i+3]=255;}c.putImageData(p,0,0);</script></body></html>`;
const fixture = `await import('/opt/pocketcoder/echo-harness.ts');Bun.serve({hostname:'127.0.0.1',port:3000,fetch(request){const url=new URL(request.url);if(url.pathname==='/typed')Bun.write('/tmp/browser-proof',url.searchParams.get('value')??'');if(url.pathname==='/clicked')Bun.write('/tmp/browser-clicked','yes');return new Response(url.pathname==='/detailed'?${JSON.stringify(detailed)}:${JSON.stringify(page)},{headers:{'content-type':'text/html'}})}});`;
const demo = await startDisplayDemo("browser", (template) => {
  template.spec.harness.command = ["bun", "/opt/pocketcoder/browser-harness.ts", "bun", "-e", fixture];
});
const sockets: WebSocket[] = [];
let paused: Awaited<ReturnType<typeof pauseBrowser>> | undefined;
async function open(control: boolean, caller?: PocketCoderClient) {
  const session = await demo.open(control, caller);
  const browser = await connectBrowser(demo.baseUrl, session.url, session.cookie);
  sockets.push(browser.socket);
  return browser;
}
async function expectClosed(closed: Promise<void>, reason: string) {
  await Promise.race([
    closed,
    Bun.sleep(2000).then(() => {
      throw new Error(reason);
    }),
  ]);
}
try {
  const control = await open(true);
  control.send({ action: "navigate", url: "http://127.0.0.1:3000/detailed" });
  await waitFor(async () => control.frames.some((frame) => frame.bytes > 65536), 5000, "detailed browser frame");
  const detailedFrame = await control.capture();
  control.send({ action: "navigate", url: "http://127.0.0.1:3000" });
  const before = await control.capture(detailedFrame);
  control.send({ action: "click", x: 150, y: 125 });
  control.send({ action: "text", text: "browser-control-proof" });
  control.send({ action: "click", x: 150, y: 225 });
  const containers = (
    await command(["docker", "ps", "-q", "--filter", `name=pocketcoder-ws-${demo.workspace.id}`], { quiet: true })
  ).stdout;
  const container = containers.split("\n")[0];
  if (!container) throw new Error("Browser container is missing.");
  await command(
    [
      "docker",
      "exec",
      container,
      "bun",
      "-e",
      `import {networkInterfaces} from 'node:os';for(const address of Object.values(networkInterfaces()).flat()){if(!address||address.internal||address.family!=='IPv4')continue;const exposed=await fetch('http://'+address.address+':9222/json/version',{signal:AbortSignal.timeout(500)}).then(()=>true,()=>false);if(exposed)throw new Error('CDP is exposed outside loopback');}`,
    ],
    { quiet: true },
  );
  for (const [path, expected] of [
    ["/tmp/browser-proof", "browser-control-proof"],
    ["/tmp/browser-clicked", "yes"],
  ]) {
    await waitFor(
      () =>
        command(["docker", "exec", container, "cat", path ?? ""], { quiet: true })
          .then((result) => result.stdout === expected)
          .catch(() => false),
      5000,
      "authorized browser input",
    );
  }
  await control.capture(before);
  await open(true).then(
    () => {
      throw new Error("Second controller was allowed.");
    },
    () => {},
  );
  const viewers = [];
  for (let index = 0; index < 4; index++) viewers.push(await open(false));
  await open(false).then(
    () => {
      throw new Error("Sixth viewer was allowed.");
    },
    () => {},
  );
  for (const viewer of viewers) {
    await viewer.capture();
    viewer.socket.close();
    await viewer.closed;
  }
  for (const forged of [
    { action: "click", x: 100, y: 100 },
    { method: "Runtime.evaluate", params: { expression: "1" } },
    { action: "arbitrary" },
  ]) {
    const viewer = await open(false);
    viewer.socket.send(new TextEncoder().encode(JSON.stringify(forged)));
    await expectClosed(viewer.closed, "Forged view-only action stayed open.");
  }
  for (const forged of [{ method: "Runtime.evaluate", params: { expression: "1" } }, { action: "arbitrary" }]) {
    control.socket.close();
    await control.closed;
    const attacker = await open(true);
    attacker.socket.send(new TextEncoder().encode(JSON.stringify(forged)));
    await expectClosed(attacker.closed, "Raw browser command stayed open.");
  }
  const issued = await demo.client.keys.issue(demo.owner.principal_id, {
    request_id: randomUUID(),
    scopes: ["display:view", "display:control", "workspaces:read"],
    templates: ["browser"],
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  });
  if (!issued.token) throw new Error("Display key was not issued.");
  const finite = new PocketCoderClient({ baseUrl: demo.baseUrl, apiKey: issued.token });
  const revoked = await open(true, finite);
  await revoked.capture();
  await demo.client.keys.revoke(demo.owner.principal_id, issued.key.id);
  await expectClosed(revoked.closed, "Revoked browser stayed open.");
  await finite.displays.open(demo.workspace.id).then(
    () => {
      throw new Error("Revoked reconnect was allowed.");
    },
    () => {},
  );
  const expiring = await demo.client.keys.issue(demo.owner.principal_id, {
    request_id: randomUUID(),
    scopes: ["display:view", "workspaces:read"],
    templates: ["browser"],
    expires_at: new Date(Date.now() + 1500).toISOString(),
  });
  if (!expiring.token) throw new Error("Expiring key was not issued.");
  const expiryClient = new PocketCoderClient({ baseUrl: demo.baseUrl, apiKey: expiring.token });
  const expiry = await open(false, expiryClient);
  await expiry.capture();
  await expectClosed(expiry.closed, "Expired browser stayed open.");
  await expiryClient.displays.open(demo.workspace.id).then(
    () => {
      throw new Error("Expired reconnect was allowed.");
    },
    () => {},
  );
  const ended = await open(true);
  await ended.capture();
  const passive = await demo.open(false);
  paused = await pauseBrowser(demo.baseUrl, passive.url, passive.cookie);
  await demo.client.agent.sendMessage(demo.workspace.id, { content: "paused-viewer-proof" });
  const messages = await (await demo.client.raw(`/v1/workspaces/${demo.workspace.id}/agent/messages`)).json();
  if (!JSON.stringify(messages).includes("paused-viewer-proof"))
    throw new Error("Paused viewer starved agent traffic.");
  if (process.argv.includes("--browser")) {
    ended.socket.close();
    await ended.closed;
    console.log(`BROWSER_URL=${(await demo.client.displays.open(demo.workspace.id, true)).url}`);
    console.log("Press Enter after checking the browser.");
    const reader = Bun.stdin.stream().getReader();
    await reader.read();
    reader.releaseLock();
  }
  await demo.client.workspaces.cancel(demo.workspace.id);
  await expectClosed(ended.closed, "Ended browser stayed open.");
  await waitFor(
    () =>
      command(["docker", "ps", "-q", "--filter", `name=pocketcoder-ws-${demo.workspace.id}`], { quiet: true }).then(
        (result) => !result.stdout,
      ),
    5000,
    "browser runtime removed",
  );
  for (let index = 1; index < control.frames.length; index++) {
    if ((control.frames[index]?.at ?? 0) - (control.frames[index - 1]?.at ?? 0) < 60)
      throw new Error("Browser exceeded 15 fps.");
  }
  console.log(
    JSON.stringify({
      result: "passed",
      imageBytes: demo.size,
      frames: true,
      detailedFrame: "reassembled",
      typedInput: true,
      rawCdp: "denied",
      viewOnly: "denied",
      secondController: "denied",
      sixthViewer: "denied",
      revokedReconnect: "denied",
      expiredReconnect: "denied",
      cdp: "loopback-only",
      pausedViewer: "agent-traffic-passes",
      endedSession: "closed",
      runtime: "removed",
    }),
  );
} finally {
  paused?.destroy();
  for (const socket of sockets) socket.close();
  await demo.close();
}
