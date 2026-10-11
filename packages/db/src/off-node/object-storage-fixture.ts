import { randomBytes, randomUUID } from "node:crypto";
import { ObjectStorage, ObjectStorageError } from "./object-storage";

async function docker(...args: string[]) {
  const process = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [code, output, error] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (code !== 0) throw new Error(error);
  return output.trim();
}

export async function objectStorageFixture() {
  const name = `pc93-s3-${randomUUID().slice(0, 8)}`;
  const accessKeyId = `pc93-${randomBytes(8).toString("hex")}`;
  const secretAccessKey = randomBytes(32).toString("hex");
  const image =
    process.env.PC93_S3_IMAGE ??
    "rustfs/rustfs@sha256:8cc9801755448b71a786705ce76692c77e14936cccd87cf2fc31842e58f4d1ff";
  try {
    await docker(
      "run",
      "-d",
      "--name",
      name,
      "--memory=512m",
      "--cpus=1",
      "-p",
      "127.0.0.1::9000",
      "-e",
      `RUSTFS_ACCESS_KEY=${accessKeyId}`,
      "-e",
      `RUSTFS_SECRET_KEY=${secretAccessKey}`,
      "-e",
      "RUSTFS_CONSOLE_ENABLE=false",
      image,
      "/data",
    );
    const published = await docker("port", name, "9000/tcp");
    const endpoint = `http://${published}`;
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        if ((await fetch(`${endpoint}/health`)).ok) break;
      } catch {}
      if (Date.now() > deadline) throw new Error(`S3 fixture did not start: ${await docker("logs", name)}`);
      await Bun.sleep(100);
    }
    const config = { endpoint, bucket: name, region: "us-east-1", accessKeyId, secretAccessKey, forcePathStyle: true };
    const storage = new ObjectStorage(config);
    for (;;) {
      try {
        await storage.request("PUT");
        break;
      } catch (error) {
        if (!(error instanceof ObjectStorageError) || error.status !== 503 || Date.now() > deadline) throw error;
      }
      await Bun.sleep(100);
    }
    await storage.request(
      "PUT",
      "",
      { versioning: "" },
      '<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>Enabled</Status></VersioningConfiguration>',
    );
    return {
      storage,
      config,
      pause: () => docker("pause", name),
      resume: () => docker("unpause", name),
      close: async () => {
        await docker("rm", "-f", "-v", name);
      },
    };
  } catch (error) {
    await docker("rm", "-f", "-v", name).catch(() => {});
    throw error;
  }
}
