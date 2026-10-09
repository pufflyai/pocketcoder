import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { issueMachineKey } from "@pstdio/pocketcoder-auth";
import { createTestStoreFactory } from "@pstdio/pocketcoder-db/testing";
import { DockerDriver } from "@pstdio/pocketcoder-drivers";
import { DEFAULT_LIMITS } from "@pstdio/pocketcoder-runtime-core";
import { buildServer } from "@pstdio/pocketcoder-server";
import { runCli } from "../../testing/cli-test-support";

const createStore = createTestStoreFactory();

test("CLI stores, lists and retires encrypted secrets through the HTTP API without printing values", async () => {
  const store = await createStore();
  const principal = await store.createPrincipal("operator", ["secrets:write"], []);
  const key = issueMachineKey("secret-cli");
  await store.insertMachineKey({
    id: key.id,
    principalId: principal.id,
    secretDigest: key.secretDigest,
    scopes: [],
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    revokedAt: null,
    lastUsedAt: null,
  });
  const built = buildServer({
    store,
    driver: new DockerDriver(),
    pepper: "secret-cli",
    secretKey: Buffer.alloc(32, 7).toString("base64url"),
    limits: DEFAULT_LIMITS,
    workspaceServerUrl: "http://127.0.0.1:0",
  });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: built.app.fetch });
  const root = await mkdtemp(join(tmpdir(), "pc-secret-cli-"));
  try {
    const file = join(root, "secret.json");
    const password = "do-not-print-registry-password";
    await writeFile(
      file,
      JSON.stringify({ type: "registry", value: { server: "registry.example", username: "operator", password } }),
      { mode: 0o600 },
    );
    const env = { POCKETCODER_URL: server.url.toString(), POCKETCODER_KEY: key.token };
    const put = await runCli(["secrets", "put", "pull", "--file", file], { cwd: root, env });
    expect(put.exitCode, put.output).toBe(0);
    expect(JSON.parse(put.output)).toMatchObject({ name: "pull", type: "registry", retired_at: null });
    expect(put.output).not.toContain(password);
    const listed = await runCli(["secrets", "list", "--json"], { cwd: root, env });
    expect(listed.exitCode, listed.output).toBe(0);
    expect(JSON.parse(listed.output)).toHaveLength(1);
    expect(listed.output).not.toContain(password);
    const streamed = await runCli(["secrets", "put", "stdin-pull", "--file=-"], {
      cwd: root,
      env,
      input: await Bun.file(file).text(),
    });
    expect(streamed.exitCode, streamed.output).toBe(0);
    expect(streamed.output).not.toContain(password);
    const document = await fetch(new URL("/v1/openapi.json", server.url));
    expect(document.status).toBe(200);
    expect(await document.text()).toContain('"putSecret"');
    await writeFile(file, `{${password}`);
    const invalid = await runCli(["secrets", "put", "pull", "--file", file], { cwd: root, env });
    expect(invalid.exitCode).toBe(1);
    expect(invalid.output).not.toContain(password);
    const retired = await runCli(["secrets", "retire", "pull"], { cwd: root, env });
    expect(retired.exitCode, retired.output).toBe(0);
    expect(JSON.parse(retired.output).retired_at).not.toBeNull();
    expect(await store.readSecret("pull")).toBeNull();
  } finally {
    await server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});
