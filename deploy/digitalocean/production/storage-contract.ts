import { randomUUID } from "node:crypto";
import { type ObjectStorage, ObjectStorageError } from "@pstdio/pocketcoder-db/off-node";

export async function initializeStorage(storage: ObjectStorage) {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      await (await storage.request("HEAD")).body?.cancel();
      break;
    } catch (error) {
      if (error instanceof ObjectStorageError && error.status === 404) break;
      if (error instanceof ObjectStorageError && error.status !== 503) throw error;
      if (Date.now() >= deadline) throw new Error("Backup storage did not become ready before startup deadline.");
      await Bun.sleep(500);
    }
  }
  try {
    await storage.request("PUT");
  } catch (error) {
    if (!(error instanceof ObjectStorageError) || error.status !== 409) throw error;
  }
  await storage.request(
    "PUT",
    "",
    { versioning: "" },
    '<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>Enabled</Status></VersioningConfiguration>',
  );
  await assertImmutableStorage(storage);
}

export async function assertImmutableStorage(storage: ObjectStorage) {
  const prefix = `deployment-probes/${randomUUID()}/`;
  const key = `${prefix}writer`;
  try {
    const first = await storage.putIfAbsent(key, Buffer.from("first writer"));
    let refused = false;
    try {
      await storage.putIfAbsent(key, Buffer.from("second writer"));
    } catch (error) {
      if (!(error instanceof ObjectStorageError) || error.status !== 412) throw error;
      refused = true;
    }
    const versions = await storage.versions(prefix);
    if (
      !refused ||
      versions.length !== 1 ||
      versions[0]?.versionId !== first.versionId ||
      !versions[0]?.latest ||
      (await (await storage.get(key)).text()) !== "first writer"
    )
      throw new Error("Storage failed immutable writer publication; deployment remains closed.");
  } finally {
    await storage.clean(prefix);
  }
}
