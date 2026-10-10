function probe() {
  return Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
}

export function controllerPorts() {
  const operator = probe();
  try {
    // Keep the first port bound so the kernel cannot choose it again for the second listener.
    const agent = probe();
    return {
      operator: Number(operator.port),
      agent: Number(agent.port),
      release() {
        operator.stop(true);
        agent.stop(true);
      },
    };
  } catch (error) {
    operator.stop(true);
    throw error;
  }
}
