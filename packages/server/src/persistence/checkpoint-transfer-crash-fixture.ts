import { checkpointHttpFixture } from "./checkpoint-transfer-fixture.test";

const phase = process.argv[2];
const f = await checkpointHttpFixture(new Uint8Array(600).fill(42));
const pending = f.service.preserve(f.workspace, f.checkpoint, f.operationId);
const grant = await f.grant;
async function interrupted() {
  console.log(
    JSON.stringify({
      dataDir: f.context.dataDir,
      directory: f.directory,
      checkpointId: f.checkpoint.id,
      operationId: f.operationId,
      workspaceId: f.workspace.id,
      transferId: grant.transfer_id,
    }),
  );
  await new Promise(() => {});
}
const stage = f.store.checkpointTransfers.stage;
f.store.checkpointTransfers.stage = async (...args) => {
  const row = await stage(...args);
  if (phase === "partial") await interrupted();
  return row;
};
const publish = f.store.checkpointTransfers.publish;
const transaction = f.context.db.transaction.bind(f.context.db);
let publishing = false;
f.context.db.transaction = (action, config) =>
  transaction(async (tx) => {
    const result = await action(tx);
    if (publishing && phase === "metadata") await interrupted();
    return result;
  }, config);
f.store.checkpointTransfers.publish = async (...args) => {
  if (phase === "rename") await interrupted();
  publishing = true;
  const row = await publish(...args);
  if (phase === "committed") await interrupted();
  return row;
};
let sent = false;
const body =
  phase === "upload"
    ? new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (!sent) {
            sent = true;
            controller.enqueue(f.raw.subarray(0, 512));
            return;
          }
          while ((await f.store.checkpointTransfers.get(grant.transfer_id))?.state !== "streaming") await Bun.sleep(10);
          await interrupted();
        },
      })
    : f.raw;
await fetch(grant.url, { method: "PUT", headers: f.headers(grant), body });
await pending;
throw new Error("Crash boundary was not reached.");
