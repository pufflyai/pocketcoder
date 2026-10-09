import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { createFilesystemCheckpointDownload } from "./filesystem-download";
import { downloadFixture } from "./filesystem-download-fixture";

async function emptyStages(f: Awaited<ReturnType<typeof downloadFixture>>) {
  expect(await readdir(f.work)).toEqual([]);
  expect(await readdir(f.state)).toEqual([]);
  expect(await readdir(f.scratch)).toEqual([]);
}

test("aborted admission cancels the owned source without creating destination entries", async () => {
  const f = await downloadFixture();
  const abort = new AbortController();
  const source = f.archive();
  abort.abort(new Error("restore deadline expired"));
  try {
    await expect(
      createFilesystemCheckpointDownload(source, f.binding, f.mounts, { ...f.options, signal: abort.signal }),
    ).rejects.toThrow("restore deadline expired");
    expect(source.locked).toBe(false);
    const reader = source.getReader();
    try {
      expect((await reader.read()).done).toBe(true);
    } finally {
      reader.releaseLock();
    }
    await emptyStages(f);
  } finally {
    await f.close();
  }
});

test("abort while real HTTP archive reception is stalled settles the download and drains owned staging", async () => {
  const f = await downloadFixture();
  const abort = new AbortController();
  const wire = Buffer.from(await new Response(f.archive()).arrayBuffer());
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(wire.subarray(0, 512));
          },
        }),
      );
    },
  });
  try {
    const response = await fetch(server.url, { signal: abort.signal });
    if (!response.body) throw new Error("Expected HTTP archive body");
    const receiving = createFilesystemCheckpointDownload(response.body, f.binding, f.mounts, {
      ...f.options,
      signal: abort.signal,
    });
    await Bun.sleep(5);
    abort.abort(new Error("restore canceled while receiving"));
    await expect(receiving).rejects.toThrow("restore canceled while receiving");
    expect(response.body.locked).toBe(false);
    await emptyStages(f);
  } finally {
    await server.stop(true);
    await f.close();
  }
});

test("prepared close is cached and removes exact owned stages without starting a runtime", async () => {
  const f = await downloadFixture();
  try {
    const prepared = await createFilesystemCheckpointDownload(f.archive(), f.binding, f.mounts, f.options);
    const first = prepared.close();
    expect(prepared.close()).toBe(first);
    await first;
    expect(() => prepared.validate()).toThrow("closed");
    await emptyStages(f);
  } finally {
    await f.close();
  }
});

test("a restored prepared result loses authority when its caller is fenced", async () => {
  const f = await downloadFixture();
  try {
    const prepared = await createFilesystemCheckpointDownload(f.archive(), f.binding, f.mounts, f.options);
    try {
      f.fence();
      expect(() => prepared.validate()).toThrow("fenced");
    } finally {
      await prepared.close();
    }
    await emptyStages(f);
  } finally {
    await f.close();
  }
});

test.each([0, -1])("custody reservation %s cannot create a partial destination stage", async (maxLedgerBytes) => {
  const f = await downloadFixture();
  try {
    await expect(
      createFilesystemCheckpointDownload(f.archive(), f.binding, f.mounts, { ...f.options, maxLedgerBytes }),
    ).rejects.toThrow("reservation");
    await emptyStages(f);
  } finally {
    await f.close();
  }
});

test("abort after preparation removes stages using destination-owned metadata after the archive index closes", async () => {
  const f = await downloadFixture();
  const abort = new AbortController();
  try {
    const prepared = await createFilesystemCheckpointDownload(f.archive(), f.binding, f.mounts, {
      ...f.options,
      signal: abort.signal,
    });
    abort.abort(new Error("destination epoch replaced"));
    await prepared.close();
    expect(() => prepared.validate()).toThrow("closed");
    await emptyStages(f);
  } finally {
    await f.close();
  }
});

test("the admitted source, destination and mount policies stay fixed across awaited native work", async () => {
  const f = await downloadFixture();
  const originalOperation = f.binding.destination.operationId;
  let changed = false;
  try {
    const prepared = await createFilesystemCheckpointDownload(f.archive(), f.binding, f.mounts, {
      ...f.options,
      check() {
        f.options.check();
        if (changed) return;
        changed = true;
        f.binding.source.workspaceId = f.binding.destination.workspaceId;
        f.binding.destination.operationId = randomUUID();
        const work = f.mounts[0];
        if (!work) throw new Error("Expected worktree mount");
        work.policy.maxBytes = 1;
      },
    });
    try {
      expect(prepared.binding.source.workspaceId).toBe(f.header.workspace_id);
      expect(prepared.binding.destination.operationId).toBe(originalOperation);
      expect(prepared.receipt.header).toEqual(f.header);
    } finally {
      await prepared.close();
    }
    await emptyStages(f);
  } finally {
    await f.close();
  }
});
