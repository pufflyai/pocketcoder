// Port-forward sockets can retire while long Kubernetes probes are running.
export const fetchForwarded = ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
  fetch(input, { ...init, keepalive: false })) as typeof fetch;
