import { writeFile } from "node:fs/promises";

export async function prepareEngineLoopback() {
  // Kata inherits an IPv4-only pod network. Tests still need private IPv6 loopback.
  await writeFile("/proc/sys/net/ipv6/conf/lo/disable_ipv6", "0");
}
