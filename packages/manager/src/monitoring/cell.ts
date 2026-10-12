import { z } from "zod";

const Resources = z.object({ requests: z.record(z.string(), z.string()).optional() }).optional();
const Container = z.object({ resources: Resources, restartPolicy: z.string().optional() });
const PodSpec = z.object({
  nodeName: z.string().optional(),
  containers: z.array(Container),
  initContainers: z.array(Container).optional(),
  overhead: z.record(z.string(), z.string()).optional(),
});
const Nodes = z.object({
  items: z.array(
    z.object({
      metadata: z.object({ name: z.string() }),
      spec: z.object({ unschedulable: z.boolean().optional() }).default({}),
      status: z.object({
        allocatable: z.record(z.string(), z.string()),
        conditions: z.array(z.object({ type: z.string(), status: z.string() })),
      }),
    }),
  ),
});
const Pods = z.object({
  items: z.array(
    z.object({
      spec: PodSpec,
      status: z.object({ phase: z.string().optional() }).default({}),
    }),
  ),
});

function bytes(value = "0") {
  const match = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))([eE][+-]?\d+|[numkKMGTPE]|[KMGTPE]i)?$/.exec(value);
  if (!match) throw new Error("Invalid Kubernetes storage quantity");
  const unit = match[2] ?? "";
  const powers: Record<string, number> = {
    n: 1e-9,
    u: 1e-6,
    m: 1e-3,
    k: 1e3,
    K: 1e3,
    M: 1e6,
    G: 1e9,
    T: 1e12,
    P: 1e15,
    E: 1e18,
    Ki: 1024,
    Mi: 1024 ** 2,
    Gi: 1024 ** 3,
    Ti: 1024 ** 4,
    Pi: 1024 ** 5,
    Ei: 1024 ** 6,
    "": 1,
  };
  const multiplier = /^[eE][+-]?\d+$/.test(unit) ? 10 ** Number(unit.slice(1)) : powers[unit];
  const result = Math.ceil(Number(match[1]) * (multiplier ?? Number.NaN));
  if (!Number.isSafeInteger(result) || result < 0) throw new Error("Invalid Kubernetes storage quantity");
  return result;
}

export function requestedStorage(input: unknown) {
  const pod = PodSpec.parse(input);
  const request = (container: z.infer<typeof Container>) => bytes(container.resources?.requests?.["ephemeral-storage"]);
  let sidecars = 0;
  let initPeak = 0;
  for (const container of pod.initContainers ?? []) {
    if (container.restartPolicy === "Always") sidecars += request(container);
    initPeak = Math.max(initPeak, sidecars + (container.restartPolicy === "Always" ? 0 : request(container)));
  }
  const apps = pod.containers.reduce((total, container) => total + request(container), sidecars);
  return Math.max(apps, initPeak) + bytes(pod.overhead?.["ephemeral-storage"]);
}

export function cellCapacity(nodeInput: unknown, podInput: unknown) {
  const nodes = Nodes.parse(nodeInput).items;
  const requests = new Map<string, number>();
  let unplacedBytes = 0;
  for (const pod of Pods.parse(podInput).items) {
    if (["Succeeded", "Failed"].includes(pod.status.phase ?? "")) continue;
    const size = requestedStorage(pod.spec);
    if (!pod.spec.nodeName) unplacedBytes += size;
    else requests.set(pod.spec.nodeName, (requests.get(pod.spec.nodeName) ?? 0) + size);
  }
  let allocatableBytes = 0;
  let requestedBytes = 0;
  let headroomBytes = 0;
  let unavailable = 0;
  let diskPressure = 0;
  for (const node of nodes) {
    const condition = (name: string) => node.status.conditions.find((entry) => entry.type === name)?.status;
    if (condition("DiskPressure") === "True") diskPressure++;
    if (node.spec.unschedulable || condition("Ready") !== "True") {
      unavailable++;
      continue;
    }
    const capacity = bytes(node.status.allocatable["ephemeral-storage"]);
    const used = requests.get(node.metadata.name) ?? 0;
    allocatableBytes += capacity;
    requestedBytes += used;
    headroomBytes += Math.max(0, capacity - used);
  }
  return {
    nodes: nodes.length,
    unavailable,
    diskPressure,
    allocatableBytes,
    requestedBytes,
    headroomBytes,
    unplacedBytes,
  };
}
