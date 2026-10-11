import { expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOffNodeConfig } from "./config";

test("a private config cannot hide archived credentials behind a parent symlink", async () => {
  const root = await mkdtemp(join(tmpdir(), "pc93-config-"));
  try {
    const data = join(root, "data");
    const archived = join(data, "db");
    const alias = join(root, "alias");
    await mkdir(archived, { recursive: true });
    await symlink(archived, alias);
    await writeFile(join(archived, "outer-key"), randomBytes(32), { mode: 0o600 });
    const config = {
      accountId: randomUUID(),
      storage: {
        endpoint: "https://example.test",
        bucket: "backup",
        region: "us-east-1",
        accessKeyId: "key",
        secretAccessKey: "secret",
      },
      encryptionKeyFile: join(alias, "outer-key"),
    };
    const privateConfig = join(root, "config.json");
    await writeFile(privateConfig, JSON.stringify(config), { mode: 0o600 });
    await expect(loadOffNodeConfig(privateConfig, data)).rejects.toThrow("outside the data folder");
    await writeFile(
      join(archived, "config.json"),
      JSON.stringify({ ...config, encryptionKeyFile: join(root, "key") }),
      { mode: 0o600 },
    );
    await writeFile(join(root, "key"), randomBytes(32), { mode: 0o600 });
    await expect(loadOffNodeConfig(join(alias, "config.json"), data)).rejects.toThrow("outside the data folder");
    await expect(loadOffNodeConfig(privateConfig, join(root, "fresh-data"))).resolves.toBeDefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
