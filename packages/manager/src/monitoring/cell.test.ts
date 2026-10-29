import { expect, test } from "bun:test";
import { cellCapacity, requestedStorage } from "./cell";

test("storage requests include restartable init sidecars, init peaks, and Pod overhead", () => {
  expect(
    requestedStorage({
      containers: [{ resources: { requests: { "ephemeral-storage": "1Gi" } } }],
      initContainers: [
        { restartPolicy: "Always", resources: { requests: { "ephemeral-storage": "512Mi" } } },
        { resources: { requests: { "ephemeral-storage": "2Gi" } } },
      ],
      overhead: { "ephemeral-storage": "128Mi" },
    }),
  ).toBe(2688 * 1024 ** 2);
});

test("cell capacity includes deleting and warm Pods, skips finished Pods, and counts unplaced requests", () => {
  const node = {
    metadata: { name: "private-node" },
    spec: {},
    status: {
      allocatable: { "ephemeral-storage": "10Gi" },
      conditions: [
        { type: "Ready", status: "True" },
        { type: "DiskPressure", status: "False" },
      ],
    },
  };
  const pod = (storage: string, phase: string, nodeName?: string) => ({
    metadata: { name: "private-workspace", deletionTimestamp: "2026-10-12T00:00:00Z" },
    spec: { nodeName, containers: [{ resources: { requests: { "ephemeral-storage": storage } } }] },
    status: { phase },
  });
  const result = cellCapacity(
    { items: [node] },
    {
      items: [
        pod("2Gi", "Running", "private-node"),
        pod("1Gi", "Running", "private-node"),
        pod("8Gi", "Succeeded", "private-node"),
        pod("4Gi", "Pending"),
      ],
    },
  );
  expect(result).toEqual({
    nodes: 1,
    unavailable: 0,
    diskPressure: 0,
    allocatableBytes: 10 * 1024 ** 3,
    requestedBytes: 3 * 1024 ** 3,
    headroomBytes: 7 * 1024 ** 3,
    unplacedBytes: 4 * 1024 ** 3,
  });
  expect(JSON.stringify(result)).not.toContain("private");
  expect(() => cellCapacity({ items: [node] }, { items: [pod("bad", "Running", "private-node")] })).toThrow();
});
