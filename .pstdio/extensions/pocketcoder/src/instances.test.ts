import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInstances } from "./instances";

const binary = resolve(import.meta.dir, "../../../../out/native/pocketcoder");

test("invalid current template limits fail before creating or starting an instance", async () => {
  const root = await mkdtemp(join(tmpdir(), "pocketcoder-invalid-limits-"));
  try {
    const manifest = await Bun.file(
      resolve(import.meta.dir, "../../../../examples/workloads/finite-process.json"),
    ).json();
    const instances = createInstances(root);
    for (const key of [
      "stagedInputBytes",
      "inputFiles",
      "inputFileBytes",
      "inFlightTransfers",
      "finalizationSeconds",
      "unreferencedInputRetentionSeconds",
    ]) {
      for (const value of [undefined, NaN, Infinity, 0, "10"]) {
        const source = structuredClone(manifest);
        source.spec.limits[key] = value;
        await expect(
          instances.launch({ name: "invalid", binary: "/missing-binary", manifests: [source] }),
        ).rejects.toThrow(`Template limits.${key}`);
        expect(await readdir(root)).toEqual([]);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("starts isolated 1.0 instances with private, expiring owner keys and restarts one", async () => {
  const root = await mkdtemp(join(tmpdir(), "pocketcoder-extension-"));
  const instances = createInstances(root);
  try {
    const first = await instances.launch({ name: "First", binary });
    const second = await instances.launch({ name: "Second", binary });
    expect(first.url).not.toBe(second.url);
    expect(first.agentPort).not.toBe(second.agentPort);
    expect(first).not.toHaveProperty("token");
    expect((await instances.list()).map((item) => item.name).sort()).toEqual(["First", "Second"]);
    const auth = JSON.parse(await readFile(join(root, first.id, "owner.json"), "utf8"));
    const consumer = JSON.parse(await readFile(join(root, first.id, "managed.json"), "utf8"));
    expect(consumer.principalId).toBe(auth.principalId);
    const client = await instances.managedClient(first.id);
    expect(await client.sessions.list()).toEqual([]);
    await expect(client.workspaces.list()).rejects.toMatchObject({ status: 403 });
    await expect(client.principals.list()).rejects.toMatchObject({ status: 403 });
    await expect(client.secrets.list()).rejects.toMatchObject({ status: 403 });
    const operator = await instances.client(first.id);
    await expect(operator.principals.list()).rejects.toMatchObject({ status: 403 });
    expect((await operator.keys.list(auth.principalId)).items.map((key) => key.effective_scopes)).not.toContainEqual([
      "admin",
    ]);
    expect(Date.parse(auth.expiresAt)).toBeLessThanOrEqual(Date.now() + 24 * 60 * 60 * 1000);
    expect((await stat(join(root, first.id, "owner.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, first.id))).mode & 0o777).toBe(0o700);
    expect(await instances.request(first.id, "/v1/templates")).toMatchObject({ items: [] });
    await instances.stop(first.id);
    expect((await instances.get(first.id)).state).toBe("stopped");
    await instances.start(first.id);
    expect((await instances.get(first.id)).state).toBe("running");
    expect(await instances.request(first.id, "/v1/templates")).toMatchObject({ items: [] });
  } finally {
    for (const id of await readdir(root)) await instances.stop(id);
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

test("an instance publishes every chosen template, sized for the largest, and accepts more later", async () => {
  const root = await mkdtemp(join(tmpdir(), "pocketcoder-many-templates-"));
  const imports = await mkdtemp(join(tmpdir(), "pocketcoder-template-import-"));
  const instances = createInstances(root);
  const manifest = await Bun.file(
    resolve(import.meta.dir, "../../../../examples/workloads/finite-process.json"),
  ).json();
  const named = (name: string, inputFiles: number) => {
    const copy = structuredClone(manifest);
    copy.metadata.name = name;
    copy.spec.limits.inputFiles = inputFiles;
    copy.spec.network = { mode: "unrestricted" };
    return copy;
  };
  try {
    const instance = await instances.launch({ name: "Many", binary, manifests: [named("a", 3), named("b", 7)] });
    expect(instance.workloadLimits?.inputFiles).toBe(7);
    await instances.publish(instance.id, named("c", 1));
    for (const key of ["inputFiles", "stagedInputBytes", "inputFileBytes", "inFlightTransfers"]) {
      const oversized = named(`too-large-${key.toLowerCase()}`, 1);
      oversized.spec.limits[key] = (instance.workloadLimits?.[key] ?? 0) + 1;
      await expect(instances.publish(instance.id, oversized)).rejects.toThrow("Launch a new instance");
    }
    await writeFile(join(imports, "a-fit.json"), JSON.stringify(named("from-directory-a", 1)));
    await writeFile(join(imports, "z-oversized.json"), JSON.stringify(named("from-directory-z", 8)));
    await expect(instances.importTemplates(instance.id, imports)).rejects.toThrow("Launch a new instance");
    expect((await instances.publishedTemplates(instance.id)).map((template) => template.name).sort()).toEqual([
      "a",
      "b",
      "c",
    ]);
    await rm(join(imports, "z-oversized.json"));
    await instances.importTemplates(instance.id, imports);
    const templates = await instances.items<{ name: string }>(instance.id, "/v1/templates");
    expect(templates.map((template) => template.name).sort()).toEqual(["a", "b", "c", "from-directory-a"]);
  } finally {
    for (const id of await readdir(root)) await instances.stop(id);
    await rm(root, { recursive: true, force: true });
    await rm(imports, { recursive: true, force: true });
  }
}, 30_000);

test("starting with a missing executable keeps the saved one", async () => {
  const root = await mkdtemp(join(tmpdir(), "pocketcoder-bad-override-"));
  const id = randomUUID();
  try {
    await mkdir(join(root, id));
    const saved = { id, name: "saved", binary, url: "http://127.0.0.1:1", agentPort: 2, state: "stopped" };
    await writeFile(join(root, id, "instance.json"), JSON.stringify(saved));
    await expect(createInstances(root).start(id, join(root, "missing"))).rejects.toThrow(
      "PocketCoder executable not found",
    );
    expect(JSON.parse(await readFile(join(root, id, "instance.json"), "utf8")).binary).toBe(binary);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an expired owner key renews itself while the controller runs, so the instance can still be managed", async () => {
  const root = await mkdtemp(join(tmpdir(), "pocketcoder-expired-key-"));
  const instances = createInstances(root);
  try {
    const instance = await instances.launch({ name: "Expired key", binary });
    const ownerPath = join(root, instance.id, "owner.json");
    const issued = JSON.parse(await readFile(ownerPath, "utf8"));
    await writeFile(ownerPath, JSON.stringify({ ...issued, expiresAt: new Date(Date.now() - 1_000).toISOString() }));
    const consumerPath = join(root, instance.id, "managed.json");
    const consumer = JSON.parse(await readFile(consumerPath, "utf8"));
    await writeFile(
      consumerPath,
      JSON.stringify({ ...consumer, expiresAt: new Date(Date.now() - 1_000).toISOString() }),
    );

    // The table, stop and remove paths all go through these calls at once.
    const [workspaces] = await Promise.all([
      instances.items(instance.id, "/v1/workspaces"),
      instances.request(instance.id, "/v1/templates"),
      instances.connection(instance.id),
      instances.managedClient(instance.id).then((client) => client.sessions.list()),
    ]);
    expect(workspaces).toEqual([]);
    expect(await instances.connection(instance.id)).toBe("Connected");
    const renewed = JSON.parse(await readFile(ownerPath, "utf8"));
    expect(renewed.token).not.toBe(issued.token);
    expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(Date.now());
    expect((await stat(ownerPath)).mode & 0o777).toBe(0o600);
    const renewedConsumer = JSON.parse(await readFile(consumerPath, "utf8"));
    expect(renewedConsumer.token).not.toBe(consumer.token);
    expect(renewedConsumer.principalId).toBe(renewed.principalId);
    expect(Date.parse(renewedConsumer.expiresAt)).toBeLessThanOrEqual(Date.parse(renewed.expiresAt));
  } finally {
    for (const id of await readdir(root)) await instances.stop(id);
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

test("reconnecting the same machine retains its conversation seed", async () => {
  const root = await mkdtemp(join(tmpdir(), "pocketcoder-session-seed-"));
  const instances = createInstances(root);
  const sessionId = randomUUID(),
    instanceId = randomUUID(),
    machineId = randomUUID(),
    conversationId = randomUUID();
  try {
    await instances.bindSession(sessionId, instanceId, machineId, conversationId);
    await instances.bindSession(sessionId, instanceId, machineId);
    expect(await instances.sessionTarget(sessionId)).toEqual({ instanceId, machineId, conversationId });
    const otherMachine = randomUUID();
    await instances.bindSession(sessionId, instanceId, otherMachine);
    expect(await instances.sessionTarget(sessionId)).toEqual({ instanceId, machineId: otherMachine });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("directory templates size the instance before its first start", async () => {
  const root = await mkdtemp(join(tmpdir(), "pc-directory-instance-"));
  const templates = await mkdtemp(join(tmpdir(), "pc-directory-templates-"));
  const instances = createInstances(root);
  try {
    const manifest = await Bun.file(
      resolve(import.meta.dir, "../../../../examples/workloads/finite-process.json"),
    ).json();
    manifest.metadata.name = "from-directory";
    manifest.spec.limits.inputFiles = 13;
    manifest.spec.network = { mode: "unrestricted" };
    await writeFile(join(templates, "agent.json"), JSON.stringify(manifest));
    const instance = await instances.launch({ name: "Directory launch", binary, templates });
    expect(instance.workloadLimits?.inputFiles).toBe(13);
    expect((await instances.publishedTemplates(instance.id)).map((template) => template.name)).toEqual([
      "from-directory",
    ]);
  } finally {
    for (const id of await readdir(root)) await instances.stop(id);
    await rm(root, { recursive: true, force: true });
    await rm(templates, { recursive: true, force: true });
  }
}, 30_000);
