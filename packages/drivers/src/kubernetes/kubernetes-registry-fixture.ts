import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDocker } from "../docker/docker-command";
import { localDockerSocket, registryImageRequest } from "../docker/docker-registry-client";

const REGISTRY_IMAGE = "registry:2@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373";

export async function run(command: string[], input?: string) {
  const child = Bun.spawn(command, { stdin: input === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe" });
  if (input !== undefined && child.stdin) {
    child.stdin.write(input);
    child.stdin.end();
  }
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code) throw new Error(`${command[0]} ${command[1]} failed: ${stderr.trim()}`);
  return stdout.trim();
}

export async function registryFixture() {
  const node = process.env.POCKETCODER_KIND_NODE;
  if (!node || !process.env.KUBECONFIG)
    throw new Error("Run bun run test:kind:registry with an isolated kind node and kubeconfig.");
  const suffix = randomUUID().slice(0, 8);
  const namespace = `pc-registry-${suffix}`;
  const directory = await mkdtemp(join(tmpdir(), "pc-kind-registry-"));
  const port = 40000 + Math.floor(Math.random() * 20000);
  const credential = { server: `127.0.0.1:${port}`, username: `pc-${suffix}`, password: randomUUID() };
  const registryName = `pc-kind-registry-${suffix}`;
  const configPath = `/etc/containerd/conf.d/${registryName}.toml`;
  const hostsPath = `/etc/containerd/certs.d/${credential.server}`;
  let registryStarted = false;
  let configured = false;
  let namespaceCreated = false;
  let tagged = "";
  const kubectl = (args: string[], input?: string) => run(["kubectl", "--namespace", namespace, ...args], input);
  const nodeCommand = (args: string[], input?: string) => run(["docker", "exec", "-i", node, ...args], input);
  async function close() {
    const failures: unknown[] = [];
    async function cleanup(work: () => Promise<unknown>) {
      try {
        await work();
      } catch (error) {
        failures.push(error);
      }
    }
    if (namespaceCreated)
      await cleanup(() =>
        kubectl(["delete", "namespace", namespace, "--ignore-not-found", "--wait=true", "--timeout=30s"]),
      );
    if (configured) {
      await cleanup(() => nodeCommand(["rm", "-rf", configPath, hostsPath]));
      await cleanup(() => nodeCommand(["systemctl", "restart", "containerd"]));
    }
    if (registryStarted) await cleanup(() => runDocker("docker", ["rm", "--force", "--volumes", registryName]));
    if (tagged) await cleanup(() => runDocker("docker", ["image", "rm", tagged]));
    await cleanup(() => rm(directory, { recursive: true, force: true }));
    if (failures.length) throw new AggregateError(failures, "Private registry fixture cleanup failed.");
  }
  try {
    const inspect = JSON.parse(await runDocker("docker", ["inspect", node]));
    const gateway = inspect[0].NetworkSettings.Networks.kind.Gateway as string;
    await writeFile(
      join(directory, "htpasswd"),
      `${credential.username}:${await Bun.password.hash(credential.password, { algorithm: "bcrypt", cost: 4 })}\n`,
      { mode: 0o600 },
    );
    await runDocker("docker", [
      "run",
      "-d",
      "--name",
      registryName,
      "--network",
      "host",
      "--mount",
      `type=bind,src=${directory},dst=/auth,readonly`,
      "-e",
      `REGISTRY_HTTP_ADDR=0.0.0.0:${port}`,
      "-e",
      "REGISTRY_AUTH=htpasswd",
      "-e",
      "REGISTRY_AUTH_HTPASSWD_REALM=pc-test",
      "-e",
      "REGISTRY_AUTH_HTPASSWD_PATH=/auth/htpasswd",
      REGISTRY_IMAGE,
    ]);
    registryStarted = true;
    tagged = `${credential.server}/workspace-${suffix}:fixture`;
    await runDocker("docker", ["tag", REGISTRY_IMAGE, tagged]);
    await waitFor(async () => {
      try {
        await runDocker("docker", [
          "exec",
          registryName,
          "sh",
          "-c",
          `wget -S --spider http://${credential.server}/v2/ 2>&1 | grep -q '401 Unauthorized'`,
        ]);
        return true;
      } catch {
        return null;
      }
    }, "private registry startup");
    const digest = await registryImageRequest(
      await localDockerSocket("docker"),
      `/images/${encodeURIComponent(`${credential.server}/workspace-${suffix}`)}/push?tag=fixture`,
      credential,
    );
    if (!digest) throw new Error("Private registry fixture digest missing.");
    await nodeCommand(["mkdir", "-p", "/etc/containerd/conf.d", hostsPath]);
    configured = true;
    await nodeCommand(
      ["tee", configPath],
      'version = 3\n[plugins."io.containerd.cri.v1.images".registry]\nconfig_path = "/etc/containerd/certs.d"\n',
    );
    // Only the test registry is mirrored. Authentication still comes from the kubelet Secret.
    await nodeCommand(["tee", `${hostsPath}/hosts.toml`], `server = "http://${gateway}:${port}"\n`);
    await nodeCommand(["systemctl", "restart", "containerd"]);
    await kubectl(["create", "namespace", namespace]);
    namespaceCreated = true;
    return { namespace, credential, image: `${credential.server}/workspace-${suffix}@${digest}`, kubectl, close };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function waitFor<T>(read: () => Promise<T | null>, label: string) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const result = await read();
    if (result !== null) return result;
    await Bun.sleep(200);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}
