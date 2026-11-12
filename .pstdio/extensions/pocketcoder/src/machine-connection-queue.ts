const connections = new Map<string, Promise<unknown>>();

export async function serializeMachineConnection<T>(
  projectId: string,
  instanceId: string,
  machineId: string,
  run: () => Promise<T>,
) {
  const key = JSON.stringify([projectId, instanceId, machineId]);
  const previous = connections.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(run);
  connections.set(key, current);
  try {
    return await current;
  } finally {
    if (connections.get(key) === current) connections.delete(key);
  }
}
