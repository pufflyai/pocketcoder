import { expect, test } from "bun:test";
import { run } from "./stack";

test("aborting startup stops an in-flight setup command", async () => {
  const controller = new AbortController();
  const command = run([process.execPath, "-e", "await Bun.sleep(30000)"], {}, controller.signal);
  controller.abort(new Error("stop setup"));
  await expect(command).rejects.toThrow("stop setup");
});
