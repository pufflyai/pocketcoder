import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PocketCoderClient } from "@pstdio/pocketcoder-sdk";
import { checkClient } from "./check-client";
import { isolatedEnvironment } from "./environment";

async function verifyCleanup(exited: Promise<number>) {
  if ((await exited) !== 0) throw new Error("Isolated cleanup failed");
}

export async function checkReconnect() {
  const directory = await mkdtemp(join(tmpdir(), "pocketcoder-reconnect-check-"));
  const command = [
    process.execPath,
    "--no-env-file",
    join(import.meta.dir, "run.ts"),
    "--state-dir",
    directory,
  ];
  const clients: ReturnType<typeof checkClient>[] = [];
  const launch = () => {
    const client = checkClient(
      Bun.spawn([...command, "--rpc", "--check-model"], {
        env: isolatedEnvironment(),
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    clients.push(client);
    return client;
  };
  const token = `RECONNECT-${crypto.randomUUID()}`;
  try {
    console.log("Reconnect check: starting the first launcher...");
    const first = launch();
    await first.prompt(`Save token ${token}`, "Saved.");
    const state = await Bun.file(join(directory, "connection.json")).json();
    console.log("Reconnect check: quitting the first launcher...");
    await first.quit();
    const saved = await Bun.file(join(directory, "connection.json")).json();
    if (saved.baseUrl !== state.baseUrl) throw new Error("Quit replaced the isolated server");
    const api = new PocketCoderClient({ baseUrl: saved.baseUrl, apiKey: saved.key });
    const response = await fetch(`${saved.controlUrl}/attach`, {
      method: "POST",
      headers: { authorization: `Bearer ${saved.controlKey}` },
      body: "{}",
    });
    const workspace = (await response.json()) as { id: string; state: string };
    if (workspace.state !== "preserved")
      throw new Error("Quit must preserve the workspace before returning");
    console.log("Reconnect check: starting the second launcher...");
    const second = launch();
    const history = (await second.entries()).entries.filter(
      (entry) => entry.customType === "pocketcoder-conversation",
    );
    const savedTurns = history.filter((entry) => entry.data?.content === `Save token ${token}`);
    if (savedTurns.length !== 1)
      throw new Error("Reconnect must show the saved user message exactly once");
    if (
      !history.some(
        (entry) => entry.data?.role === "assistant" && entry.data.content?.includes("Saved."),
      )
    )
      throw new Error(`Reconnect must show the saved assistant reply: ${JSON.stringify(history)}`);
    await second.prompt("Recall the original token from our conversation.", token);
    await second.prompt("Read the saved file.", token);
    await second.quit();
    const third = launch();
    const resumedHistory = (await third.entries()).entries;
    if (!resumedHistory.some((entry) => entry.data?.content === "Read the saved file.")) {
      throw new Error("Later reconnect must follow the resumed workspace");
    }
    await third.quit();
    const source = await api.workspaces.get(workspace.id);
    if (source.state !== "preserved") throw new Error("The original checkpoint was lost");
    console.log(
      "Reconnect check passed: /quit, second launcher, visible history, model context and file restored.",
    );
  } finally {
    for (const client of clients) await client.close();
    const stop = Bun.spawn([...command, "--stop"], {
      env: isolatedEnvironment(),
      stdout: "inherit",
      stderr: "inherit",
    });
    await verifyCleanup(stop.exited);
    await rm(directory, { recursive: true, force: true });
  }
}

if (import.meta.main) await checkReconnect();
