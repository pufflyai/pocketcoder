import { expect, test } from "bun:test";
import { countUsagePods } from "./observation";

test("usage counts running non-deleting pods, excludes finished jobs, and moves assigned warm pods into workspaces", () => {
  const pod = (labels: Record<string, string>, phase = "Running", metadata = {}, state: object = { running: {} }) => ({
    metadata: { labels, ...metadata },
    status: { phase, containerStatuses: [{ name: "workspace", state }] },
  });
  expect(
    countUsagePods(
      {
        items: [
          pod({ "pocketcoder.workspace": "one" }),
          pod({ "pocketcoder.workspace": "deleting" }, "Running", { deletionTimestamp: "2026-10-10T00:00:00Z" }),
          pod({ "pocketcoder.workspace": "finished" }, "Succeeded"),
          pod({ "pocketcoder.workspace": "failed" }, "Failed"),
          pod({ "pocketcoder.workspace": "pending" }, "Pending"),
          pod({ "pocketcoder.workspace": "sidecar" }, "Running", {}, { terminated: { exitCode: 0 } }),
          pod({ "pocketcoder.pool-runtime": "available" }),
          pod({ "pocketcoder.pool-runtime": "assigned" }),
          pod({ "pocketcoder.dev/role": "controller" }),
        ],
      },
      ["assigned"],
    ),
  ).toEqual({ workspaces: 2, warm: 1 });
});

test("malformed pod observation is refused instead of reported as zero", () => {
  expect(() => countUsagePods({ unavailable: true }, [])).toThrow();
});
