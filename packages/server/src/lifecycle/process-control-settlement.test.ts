// Separates actual descriptor settlement from missing or substituted private capability originals.
import { expect, spyOn, test } from "bun:test";
import * as files from "node:fs/promises";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig } from "../config/config";
import { createTestServer } from "../testing/test-server.test";
import { startControllerListener } from "./controller-listener";
import { startProcessControl } from "./process-control";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ctl-"));
  const built = await createTestServer();
  const config = {
    ...loadConfig({ POCKETCODER_STORE: "memory", POCKETCODER_PEPPER: "synthetic-process-owner" }),
    listenHost: "127.0.0.1",
    listenPort: 0,
  };
  const running = startControllerListener(config, built, { store: built.store, timers: [] });
  const instanceId = crypto.randomUUID();
  const control = await startProcessControl({ running, root, instanceId });
  return {
    root,
    running,
    control,
    async cleanup() {
      await running.stop();
      await rm(root, { recursive: true });
    },
  };
}

test("missing capability cannot keep the original live listener open", async () => {
  const f = await fixture();
  try {
    await rm(f.control.capabilityPath);
    await f.control.stop();
    await expect(fetch(`${f.control.url}/quiesce`)).rejects.toThrow();
  } finally {
    await f.cleanup();
  }
});

test("substituted capability refuses deletion after exact listener closure", async () => {
  const f = await fixture();
  try {
    await rename(f.control.capabilityPath, `${f.control.capabilityPath}.original`);
    await writeFile(f.control.capabilityPath, "synthetic-foreign-original", { flag: "wx", mode: 0o600 });
    await expect(f.control.stop()).rejects.toThrow("controller_control_file_changed");
    await expect(fetch(`${f.control.url}/quiesce`)).rejects.toThrow();
    expect(await readFile(f.control.capabilityPath, "utf8")).toBe("synthetic-foreign-original");
  } finally {
    await f.cleanup();
  }
});

test("a capability replacement after identity observation survives descriptor settlement", async () => {
  const f = await fixture();
  const originalLstat = files.lstat;
  let replaced = false;
  // Forward the original overloads, including bigint observations, without changing their values.
  const observation = spyOn(files, "lstat").mockImplementation((async (...args) => {
    const identity = await originalLstat(...args);
    if (args[0] === f.control.capabilityPath && !replaced) {
      replaced = true;
      await rename(f.control.capabilityPath, `${f.control.capabilityPath}.original`);
      await writeFile(f.control.capabilityPath, "synthetic-after-observation", { flag: "wx", mode: 0o600 });
    }
    return identity;
  }) as typeof files.lstat);
  try {
    await f.control.stop().catch(() => undefined);
    expect(replaced).toBe(true);
    await expect(fetch(`${f.control.url}/quiesce`)).rejects.toThrow();
    expect(await readFile(f.control.capabilityPath, "utf8")).toBe("synthetic-after-observation");
  } finally {
    observation.mockRestore();
    await f.cleanup();
  }
});

test("stopped control retains private inert originals without pathname deletion", async () => {
  const f = await fixture();
  try {
    const original = await files.lstat(f.control.capabilityPath);
    await f.control.stop();
    const retained = await files.lstat(f.control.capabilityPath);
    expect(retained.ino).toBe(original.ino);
    expect(retained.mode & 0o777).toBe(0o600);
    await expect(fetch(`${f.control.url}/quiesce`)).rejects.toThrow();
  } finally {
    await f.cleanup();
  }
});

test("substituted directory refuses deletion after exact listener closure", async () => {
  const f = await fixture();
  const directory = dirname(f.control.capabilityPath);
  try {
    await rename(directory, `${directory}.original`);
    await mkdir(directory, { mode: 0o700 });
    const foreign = join(directory, "foreign.safe.txt");
    await writeFile(foreign, "synthetic-foreign-directory", { flag: "wx", mode: 0o600 });
    await expect(f.control.stop()).rejects.toThrow("controller_control_directory_changed");
    await expect(fetch(`${f.control.url}/quiesce`)).rejects.toThrow();
    expect(await readFile(foreign, "utf8")).toBe("synthetic-foreign-directory");
  } finally {
    await f.cleanup();
  }
});

test("neither a tenant key nor an unauthenticated localhost request closes admission", async () => {
  const f = await fixture();
  try {
    for (const authorization of ["", `Bearer ${"0".repeat(64)}`, "Bearer synthetic-tenant-machine-key"]) {
      expect(
        (await fetch(`${f.control.url}/quiesce`, { method: "POST", headers: { authorization }, body: "{}" })).status,
      ).toBe(409);
    }
    expect((await fetch(`${f.running.url}/livez`)).status).toBe(200);
    await f.control.stop();
  } finally {
    await f.cleanup();
  }
});
