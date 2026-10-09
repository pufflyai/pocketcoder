export function parseHttpAddress(value: string, setting = "POCKETCODER_HTTP") {
  const matched = /^(\[[^\]]+\]|[^:/?#@\s]+):(\d+)$/.exec(value);
  if (!matched) throw new Error(`${setting} must be a host:port bind address`);
  const port = Number(matched[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${setting} port must be from 1 to 65535`);
  }
  const host = matched[1] as string;
  return { listenHost: host.replace(/^\[|\]$/g, ""), listenPort: port };
}

export function listenerOrigin(host: string, port: number | undefined) {
  const reachableHost = ["0.0.0.0", "::"].includes(host) ? "127.0.0.1" : host;
  const authority = reachableHost.includes(":") ? `[${reachableHost}]` : reachableHost;
  return `http://${authority}:${port}`;
}
