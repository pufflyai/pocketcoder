import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FiniteProcess } from "./finite-process";

test.each([0, 50])("ordinary exit honors a delivered cancel's remaining %s ms grace", async (graceMs) => {
  const root = await mkdtemp(join(tmpdir(), "pc-cancel-grace-"));
  const ready = join(root, "ready");
  const ref = {
    workspaceId: randomUUID(),
    incarnationId: "grace-runtime",
    owner: "process" as const,
    requestId: randomUUID(),
  };
  let terminalAt = 0;
  const owner = new FiniteProcess(
    ref.workspaceId,
    ref.incarnationId,
    (fact) => {
      if (fact.phase === "exited") terminalAt = performance.now();
    },
    undefined,
    1000,
  );
  try {
    owner.start(ref, `sha256:${"a".repeat(64)}`, {
      command: [
        "/bin/sh",
        "-c",
        `(trap '' TERM; echo ready > '${ready}'; while :; do sleep 1; done) >/dev/null 2>&1 & while [ ! -f '${ready}' ]; do sleep 0.01; done; exit 7`,
      ],
      env: {},
    });
    await owner.exited();
    await Bun.sleep(20);
    const deliveredAt = performance.now();
    const cancelId = randomUUID();
    expect(owner.cancelOperation(ref, cancelId, graceMs === 0 ? "SIGKILL" : "SIGTERM", graceMs)).toBe("requested");
    // A repeated delivery must not extend the earlier deadline.
    owner.cancelOperation(ref, cancelId, "SIGTERM", 1000);
    await owner.drained;
    expect(terminalAt - deliveredAt).toBeLessThan(300);
    expect(owner.lookup(ref)).toMatchObject({ exitCode: 7, signal: null });
  } finally {
    await owner.stopWriters("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});
