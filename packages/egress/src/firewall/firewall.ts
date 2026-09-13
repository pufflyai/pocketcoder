const CHAIN = "POCKETCODER_EGRESS";

export function firewallCommands(binary: string, uid: number): string[][] {
  return [
    [binary, "-N", CHAIN],
    [binary, "-F", CHAIN],
    [binary, "-A", CHAIN, "-o", "lo", "-j", "ACCEPT"],
    [binary, "-A", CHAIN, "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "ACCEPT"],
    [binary, "-A", CHAIN, "-m", "owner", "--uid-owner", String(uid), "-j", "ACCEPT"],
    [binary, "-A", CHAIN, "-j", "REJECT"],
    [binary, "-I", "OUTPUT", "1", "-j", CHAIN],
  ];
}

async function run(command: string[], tolerateFailure = false) {
  const process = Bun.spawn(command, { stdout: "inherit", stderr: "inherit" });
  const exitCode = await process.exited;
  if (exitCode !== 0 && !tolerateFailure) {
    throw new Error(`firewall command failed (${exitCode}): ${command.join(" ")}`);
  }
}

export async function configureFirewall(uid = 999) {
  for (const binary of ["iptables", "ip6tables"]) {
    const commands = firewallCommands(binary, uid);
    await run(commands[0] as string[], true);
    for (const command of commands.slice(1, -1)) await run(command);
    const jump = commands.at(-1) as string[];
    const check = [binary, "-C", "OUTPUT", "-j", CHAIN];
    const process = Bun.spawn(check, { stdout: "ignore", stderr: "ignore" });
    if ((await process.exited) !== 0) await run(jump);
  }
}
