import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySecretValue, readSecretValue } from "./kubernetes-secret-values";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

// A stand-in kubectl that keeps one Secret in a file and records its arguments.
async function fakeKubectl() {
  const directory = await mkdtemp(join(tmpdir(), "pocketcoder-secret-values-"));
  directories.push(directory);
  const bin = join(directory, "kubectl");
  await writeFile(
    bin,
    `#!/bin/sh
echo "$@" >> "${directory}/args"
case "$*" in
  *" apply -f -") cat > "${directory}/secret.json" ;;
  *" get secret "*)
    if [ ! -f "${directory}/secret.json" ]; then echo 'Error from server (NotFound): secrets "x" not found' >&2; exit 1; fi
    cat "${directory}/secret.json" ;;
esac
`,
  );
  await chmod(bin, 0o700);
  return { bin, directory };
}

test("a Secret value is written through stdin and read back", async () => {
  const kubectl = await fakeKubectl();
  const target = { namespace: "consumer", name: "backend-key", key: "token" };
  expect(await readSecretValue(kubectl.bin, target)).toBeNull();
  await applySecretValue(kubectl.bin, target, "pkt_secret-value");
  const manifest = JSON.parse(await readFile(join(kubectl.directory, "secret.json"), "utf8"));
  expect(manifest).toMatchObject({ kind: "Secret", metadata: { name: "backend-key", namespace: "consumer" } });
  // The fake returns what was applied; the real API returns data as base64.
  manifest.data = { token: Buffer.from(manifest.stringData.token).toString("base64") };
  await writeFile(join(kubectl.directory, "secret.json"), JSON.stringify(manifest));
  expect(await readSecretValue(kubectl.bin, target)).toBe("pkt_secret-value");
  expect(await readFile(join(kubectl.directory, "args"), "utf8")).not.toContain("pkt_");
});

test("a failed write does not echo the value", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pocketcoder-secret-values-"));
  directories.push(directory);
  const bin = join(directory, "kubectl");
  await writeFile(bin, `#!/bin/sh\ncat >&2\nexit 1\n`);
  await chmod(bin, 0o700);
  const error = await applySecretValue(bin, { namespace: "n", name: "s", key: "k" }, "pkt_leak").catch((e) => e);
  expect(String(error)).not.toContain("pkt_leak");
});
