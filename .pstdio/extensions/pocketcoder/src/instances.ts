import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { freePort, runCli } from "./local-cli";

export interface Instance {
  id: string;
  name: string;
  binary: string;
  url: string;
  agentPort: number;
  state: "running" | "stopped";
}

export const instancesFor = (projectId: string) =>
  createInstances(join(homedir(), ".local", "share", "pocketcoder-pstdio", projectId));

export function createInstances(root: string) {
  const directory = (id: string) => {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid PocketCoder instance ID.");
    return join(root, id);
  };
  const read = async <T>(id: string, file: string) =>
    JSON.parse(await readFile(join(directory(id), file), "utf8")) as T;
  const write = async (id: string, file: string, value: unknown) => {
    const path = join(directory(id), file);
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await rename(temporary, path);
  };
  const environment = (instance: Instance) => ({
    POCKETCODER_DIR: join(directory(instance.id), "data"),
    POCKETCODER_STATE_DIR: join(directory(instance.id), "state"),
    POCKETCODER_HTTP: new URL(instance.url).host,
    POCKETCODER_AGENT_HTTP: `0.0.0.0:${instance.agentPort}`,
    POCKETCODER_WORKSPACE_SERVER_URL: `http://host.docker.internal:${instance.agentPort}`,
    POCKETCODER_STORAGE_BACKEND: "filesystem",
    POCKETCODER_WORKSPACE_DATA_DIR: join(directory(instance.id), "workspaces"),
    POCKETCODER_CHECKPOINT_DIR: join(directory(instance.id), "checkpoints"),
  });
  const cli = async (instance: Instance, args: string[], extra: Record<string, string> = {}) => {
    const result = await runCli(instance.binary, directory(instance.id), { ...environment(instance), ...extra }, args);
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `PocketCoder ${args[0]} failed.`);
    return result.stdout;
  };
  const get = async (id: string) => {
    const instance = await read<Instance>(id, "instance.json");
    const result = await runCli(instance.binary, directory(id), environment(instance), ["server", "status", "--json"]);
    instance.state = result.exitCode === 0 ? "running" : "stopped";
    return instance;
  };
  const start = async (id: string) => {
    const instance = await get(id);
    if (instance.state === "stopped") await cli(instance, ["server", "start"]);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const issued = JSON.parse(
      await cli(instance, ["superuser", "create", "--automation", "--expires", expiresAt, "--json"]),
    );
    // This owner key stays on the host. Provider refs and workspace files contain only IDs.
    await write(id, "owner.json", { token: issued.token, expiresAt: issued.key.expires_at });
    return get(id);
  };
  const request = async <T>(id: string, path: string, options: RequestInit = {}) => {
    const instance = await read<Instance>(id, "instance.json");
    const owner = await read<{ token: string; expiresAt: string }>(id, "owner.json");
    if (Date.parse(owner.expiresAt) <= Date.now())
      throw new Error("Instance key expired. Start the instance to renew it.");
    const response = await fetch(`${instance.url}${path}`, {
      ...options,
      headers: { "content-type": "application/json", authorization: `Bearer ${owner.token}`, ...options.headers },
      signal: options.signal ?? AbortSignal.timeout(35_000),
    });
    if (!response.ok) throw new Error(`PocketCoder HTTP ${response.status}: ${await response.text()}`);
    return response.json() as Promise<T>;
  };
  return {
    get,
    start,
    request,
    async items<T>(id: string, path: string) {
      const items: T[] = [];
      let cursor: string | null = null;
      do {
        const query = new URLSearchParams({ limit: "200" });
        if (cursor) query.set("cursor", cursor);
        const page: { items: T[]; next_cursor: string | null } = await request(id, `${path}?${query}`);
        items.push(...page.items);
        cursor = page.next_cursor;
      } while (cursor);
      return items;
    },
    async list() {
      await mkdir(root, { recursive: true, mode: 0o700 });
      const entries = await readdir(root, { withFileTypes: true });
      return Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => get(entry.name)));
    },
    async launch(input: { name: string; binary: string; templates?: string }) {
      const id = randomUUID();
      await mkdir(directory(id), { recursive: true, mode: 0o700 });
      await writeFile(join(directory(id), "empty.env"), "", { mode: 0o600 });
      const operatorPort = await freePort();
      let agentPort = await freePort();
      while (agentPort === operatorPort) agentPort = await freePort();
      const instance: Instance = {
        id,
        name: input.name,
        binary: input.binary,
        url: `http://127.0.0.1:${operatorPort}`,
        agentPort,
        state: "stopped",
      };
      await write(id, "instance.json", instance);
      const started = await start(id);
      if (input.templates) await this.importTemplates(id, input.templates);
      return started;
    },
    async importTemplates(id: string, templates: string) {
      const instance = await get(id);
      const owner = await read<{ token: string }>(id, "owner.json");
      await cli(instance, ["templates", "import", templates], {
        POCKETCODER_URL: instance.url,
        POCKETCODER_KEY: owner.token,
      });
    },
    async stop(id: string) {
      const instance = await get(id);
      if (instance.state === "running") await cli(instance, ["server", "stop"]);
      return get(id);
    },
  };
}
