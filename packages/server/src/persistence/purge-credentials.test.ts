import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerDriver, FilesystemStorageDriver } from "@pstdio/pocketcoder-drivers";
import { DEFAULT_LIMITS } from "@pstdio/pocketcoder-runtime-core";
import { buildServer } from "../app";
import { createIssuerClient } from "../secrets/issuer-client";
import { leaseServiceFixture } from "../secrets/lease-service-fixture";

test("purge stays pending until the issuer revokes the workspace credential", async () => {
  const f = await leaseServiceFixture("disk", undefined, undefined, true);
  const directory = await mkdtemp(join(tmpdir(), "pc-purge-credentials-"));
  let built: ReturnType<typeof buildServer> | undefined;
  try {
    await f.store.updatePrincipal(f.principal.id, ["admin"], ["*"]);
    const principal = (await f.store.listPrincipals()).find((row) => row.id === f.principal.id);
    if (!principal) throw new Error("Missing principal");
    await f.vault.put(f.key.id, "runtime", { ...f.config, type: "runtime-issuer" });
    const initial = await f.service.issue(f.workspace.id, "runtime", "runtime-issuer");
    built = buildServer({
      store: f.store,
      driver: new DockerDriver({ inputDir: join(directory, "inputs") }),
      storageDriver: new FilesystemStorageDriver({
        workspaceRoot: join(directory, "workspaces"),
        checkpointRoot: join(directory, "archives"),
      }),
      pepper: f.pepper,
      secretKey: f.encryptionKey.toString("base64url"),
      issuerClient: createIssuerClient({ ca: f.issuer.ca }),
      limits: DEFAULT_LIMITS,
      workspaceServerUrl: "http://127.0.0.1",
    });
    f.issuer.controls.reply = "outage";
    const purge = await built.persistence.purge(principal, f.workspace.id, randomUUID());
    await built.persistence.drain();
    expect(await f.store.getOperation(purge.id)).toMatchObject({
      state: "pending",
      reasonCode: "purge_termination_unresolved",
      completedAt: null,
    });
    expect((await f.store.getWorkspace(f.workspace.id))?.terminalAt).toBeNull();
    expect(await f.issuer.resource(initial.credential, f.workspace.id)).toBe(200);
    f.issuer.controls.reply = "valid";
    expect(await built.persistence.retryPurges()).toBe(0);
    expect((await f.store.getOperation(purge.id))?.state).toBe("succeeded");
    expect(await f.issuer.resource(initial.credential, f.workspace.id)).toBe(401);
    expect(await f.store.listPendingWorkspaceLeases(f.workspace.id)).toEqual([]);
  } finally {
    f.issuer.controls.reply = "valid";
    await built?.persistence.drain();
    await f.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);
