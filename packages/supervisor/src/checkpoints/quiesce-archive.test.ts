import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { quiesceArchive } from "./quiesce-archive";

test("archive capture stops an ordinary real writer without a checkpoint hook", async () => {
  const child = Bun.spawn(
    [process.execPath, "-e", 'process.on("SIGTERM",()=>process.exit(0)); console.log("ready"); setInterval(()=>{},10)'],
    { stdout: "pipe", stderr: "ignore" },
  );
  const reader = child.stdout.getReader();
  await reader.read();
  const phases: string[] = [];
  let quiescing = false;
  try {
    expect(
      await quiesceArchive(randomUUID(), 1000, new AbortController().signal, {
        native: false,
        hasHook: false,
        prepareHook: async () => {
          throw new Error("No hook");
        },
        closeSessions: async () => {},
        setQuiescing: () => {
          quiescing = true;
        },
        child: () => child,
        drainChild: async () => {
          await child.exited;
        },
        send: (_type, payload) => {
          phases.push((payload as { phase: string }).phase);
          return true;
        },
      }),
    ).toBe(true);
    expect(quiescing).toBe(true);
    expect(await child.exited).toBe(0);
    expect(phases).toEqual(["quiescing", "quiesced"]);
  } finally {
    child.kill();
    reader.releaseLock();
  }
});
