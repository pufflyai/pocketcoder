import { randomUUID } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  OperationResourceSchema,
  PreserveResponseSchema,
  RestoreResponseSchema,
  WorkspaceResourceSchema,
} from "@pstdio/pocketcoder-contracts";
import { PGliteStore } from "@pstdio/pocketcoder-db";
import { checkpointSourceFixture } from "./checkpoint-source-fixture";
import { messageList, responseText } from "./contract-messages";
import { command, waitFor } from "./local-process";

const fixture = await checkpointSourceFixture({ deadlinePolicy: true });
try {
  const source = await fixture.createSource();
  const request = source.request;
  const workspaces = [source.workspaceId];
  const checkpoints: string[] = [];
  async function operation(id: string) {
    await waitFor(
      async () => {
        const row = OperationResourceSchema.parse(await (await request(`/v1/operations/${id}`)).json());
        if (row.state === "failed") throw new Error(`Operation failed: ${row.reason_code}`);
        return row.state === "succeeded";
      },
      30_000,
      "checkpoint operation",
    );
  }
  async function preserve(id: string) {
    const response = await request(`/v1/workspaces/${id}/preserve`, {
      method: "POST",
      headers: { "idempotency-key": randomUUID() },
      body: "{}",
    });
    if (!response.ok) throw new Error(`Repeat preserve refused: ${await response.text()}`);
    const result = PreserveResponseSchema.parse(await response.json());
    await operation(result.operation.id);
    checkpoints.push(result.checkpoint.id);
    return result.checkpoint.id;
  }
  async function restore(checkpoint: string) {
    const response = await request(`/v1/checkpoints/${checkpoint}/restore`, {
      method: "POST",
      headers: { "idempotency-key": randomUUID() },
      body: JSON.stringify({ external_id: randomUUID() }),
    });
    if (!response.ok) throw new Error(`Repeat restore refused: ${await response.text()}`);
    const result = RestoreResponseSchema.parse(await response.json());
    fixture.ownWorkspace(result.workspace.id);
    workspaces.push(result.workspace.id);
    await operation(result.operation.id);
    const workspace = WorkspaceResourceSchema.parse(
      await (await request(`/v1/workspaces/${result.workspace.id}`)).json(),
    );
    if (workspace.state !== "ready") throw new Error("Repeat restore succeeded before readiness");
    return result.workspace.id;
  }
  async function write(id: string, bytes: Buffer) {
    await command(
      [
        "docker",
        "exec",
        `pocketcoder-ws-${id}`,
        "bun",
        "-e",
        `await Bun.write('/work/known',Buffer.from('${bytes.toString("base64")}','base64'));`,
      ],
      { quiet: true },
    );
  }
  async function verify(id: string, bytes: Buffer) {
    const read = await command(
      [
        "docker",
        "exec",
        `pocketcoder-ws-${id}`,
        "bun",
        "-e",
        "console.log(Buffer.from(await Bun.file('/work/known').arrayBuffer()).toString('base64'));",
      ],
      { quiet: true },
    );
    if (read.stdout !== bytes.toString("base64")) throw new Error("Repeated restore changed exact edited bytes");
    const prompt = randomUUID();
    const sent = await request(`/v1/workspaces/${id}/agent/message`, {
      method: "POST",
      body: JSON.stringify({ type: "user", content: prompt }),
    });
    if (!sent.ok) throw new Error("Repeated restore harness unavailable");
    await waitFor(
      async () => {
        const page = await (await request(`/v1/workspaces/${id}/agent/messages`)).json();
        return responseText(messageList(page), 0) === `echo: ${prompt}`;
      },
      30_000,
      "repeated restored harness response",
    );
  }
  const firstBytes = Buffer.from([0, 1, 2, 255]);
  const editedBytes = Buffer.from(Array.from({ length: 64 }, (_, index) => (index * 17) % 256));
  await write(source.workspaceId, firstBytes);
  const first = await restore(await preserve(source.workspaceId));
  await verify(first, firstBytes);
  await write(first, editedBytes);
  const second = await restore(await preserve(first));
  await verify(second, editedBytes);
  await waitFor(
    async () => {
      const row = WorkspaceResourceSchema.parse(await (await request(`/v1/workspaces/${second}`)).json());
      if (row.state === "failed" || row.state === "expired")
        throw new Error(`Restored deadline policy failed: ${row.reason_code}`);
      if (row.state !== "preserved") return false;
      if (!row.persistence.latest_checkpoint_id) throw new Error("Policy preserve has no checkpoint");
      checkpoints.push(row.persistence.latest_checkpoint_id);
      return true;
    },
    30_000,
    "deadline policy preserve on restored destination",
  );
  const policyCheckpoint = checkpoints.at(-1);
  if (!policyCheckpoint) throw new Error("Policy checkpoint missing");
  const third = await restore(policyCheckpoint);
  await verify(third, editedBytes);
  const canceled = await request(`/v1/workspaces/${third}/cancel`, { method: "POST" });
  if (!canceled.ok) throw new Error("Repeated restore cancellation refused");
  await waitFor(
    async () =>
      WorkspaceResourceSchema.parse(await (await request(`/v1/workspaces/${third}`)).json()).state === "canceled",
    30_000,
    "repeated destination teardown",
  );
  await fixture.stop();
  const store = await PGliteStore.create(fixture.dataDir);
  let allocated = 0;
  try {
    await store.init();
    const archives: string[] = [];
    for (const id of checkpoints) {
      const checkpoint = await store.getCheckpoint(id);
      const publication = await store.checkpointTransfers.publication(id);
      if (
        checkpoint?.state !== "ready" ||
        !publication?.stagePath ||
        publication.grantDigest ||
        !publication.completedAt
      )
        throw new Error("Repeated preserve has no durable settled archive");
      archives.push(publication.stagePath);
      const blocks =
        Number((await stat(join(fixture.checkpointDir, publication.stagePath), { bigint: true })).blocks) * 512;
      allocated += blocks;
      const reservation = await store.storageReservations.get(publication.reservationId ?? "");
      if (
        reservation?.state !== "committed" ||
        reservation.reservedBytes !== blocks ||
        reservation.materializedBytes !== blocks
      )
        throw new Error("Repeated archive allocation did not settle exactly");
    }
    if (JSON.stringify((await readdir(fixture.checkpointDir)).sort()) !== JSON.stringify(archives.sort()))
      throw new Error("Repeated transfer retained scratch");
    const usage = await store.storageReservations.usage(null, null);
    if (
      usage.instance.bytes !== allocated ||
      usage.instance.files !== 3 ||
      usage.outstanding.bytes ||
      usage.outstanding.files
    )
      throw new Error("Repeated transfers left unaccounted storage");
    for (const [index, id] of workspaces.entries()) {
      const workspace = await store.getWorkspace(id);
      const storage = await store.listWorkspaceStorage(id);
      if (
        workspace?.state !== (index === 3 ? "canceled" : "preserved") ||
        workspace.registrationDigest ||
        workspace.registrationExpiresAt ||
        workspace.reconnectDigest ||
        workspace.launchInput ||
        storage.length !== 1 ||
        storage[0]?.state !== "deleted"
      )
        throw new Error("Repeated workspace retained runtime/storage authority");
      if ((await command(["docker", "ps", "-aq", "--filter", `name=^/pocketcoder-ws-${id}$`], { quiet: true })).stdout)
        throw new Error("Repeated workspace retained its source container");
    }
    const restoredSource = await store.getWorkspace(second);
    if (!restoredSource) throw new Error("Restored policy workspace missing");
    const policy = await store.getOperationByIdempotency(
      restoredSource.principalId,
      "preserve",
      `policy:deadline:${second}`,
    );
    if (policy?.state !== "succeeded" || policy.reasonCode !== "preserved_by_policy")
      throw new Error("Restored policy operation did not settle");
  } finally {
    await store.close();
  }
  console.log(
    JSON.stringify(
      {
        result: "passed",
        workspaces,
        checkpoints,
        restoredEditedBytes: editedBytes.length,
        deadlinePolicy: "preserved",
        allocatedBytes: allocated,
        outstandingBytes: 0,
      },
      null,
      2,
    ),
  );
} finally {
  await fixture.dispose();
}
