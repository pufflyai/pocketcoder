import { connectDesktop } from "./desktop-client";
import { startDisplayDemo } from "./display-runtime";
import { command, waitFor } from "./local-process";

const demo = await startDisplayDemo("desktop");
const { client, workspace, baseUrl, open, size } = demo;
const sockets: WebSocket[] = [];
try {
  const viewing = await open(false);
  const viewer = await connectDesktop(baseUrl, viewing.url, viewing.cookie);
  sockets.push(viewer.socket);
  const screen = await viewer.capture();
  viewer.socket.send(new Uint8Array([4, 1, 0]));
  viewer.socket.send(new Uint8Array([0, 0, 0, 0, 65]));
  await Promise.race([
    viewer.closed,
    Bun.sleep(2000).then(() => {
      throw new Error("Forged view-only input was not closed.");
    }),
  ]);
  const controlled = await open(true);
  const control = await connectDesktop(baseUrl, controlled.url, controlled.cookie);
  sockets.push(control.socket);
  await control.capture();
  const second = await open(true);
  await connectDesktop(baseUrl, second.url, second.cookie).then(
    () => {
      throw new Error("Second controller was allowed.");
    },
    () => {},
  );
  control.click(300, 250);
  control.type("printf pc-control > /tmp/desktop-control-proof");
  const containers = (
    await command(["docker", "ps", "-q", "--filter", `name=pocketcoder-ws-${workspace.id}`], { quiet: true })
  ).stdout;
  if (!containers) throw new Error("Missing desktop container.");
  await waitFor(
    () =>
      command(["docker", "exec", containers.split("\n")[0] ?? "", "cat", "/tmp/desktop-control-proof"], { quiet: true })
        .then((result) => result.stdout === "pc-control")
        .catch(() => false),
    5000,
    "authorized desktop input",
  );
  const changed = await control.capture();
  if (changed === screen) throw new Error("Authorized input did not change the desktop.");
  if (process.argv.includes("--browser")) {
    control.socket.close();
    await control.closed;
    console.log(`BROWSER_URL=${(await client.displays.open(workspace.id, true)).url}`);
    console.log("Press Enter after checking the browser.");
    const reader = Bun.stdin.stream().getReader();
    await reader.read();
    reader.releaseLock();
  }
  await client.workspaces.cancel(workspace.id);
  await Promise.race([
    control.closed,
    Bun.sleep(2000).then(() => {
      throw new Error("Ended display did not close.");
    }),
  ]);
  console.log(
    JSON.stringify({
      result: "passed",
      imageBytes: size,
      nonblank: true,
      typedInput: true,
      forgedInput: "denied",
      secondController: "denied",
      endedSession: "closed",
    }),
  );
} finally {
  for (const socket of sockets) socket.close();
  await demo.close();
}
