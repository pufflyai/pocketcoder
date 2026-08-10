import { describe, expect, test } from "bun:test";
import { firewallCommands } from "./firewall";

describe("firewall command projection", () => {
  test("allows only loopback, established responses, and the gateway uid", () => {
    for (const binary of ["iptables", "ip6tables"]) {
      const commands = firewallCommands(binary, 999).map((command) => command.join(" "));
      expect(commands).toContain(`${binary} -A POCKETCODER_EGRESS -o lo -j ACCEPT`);
      expect(commands).toContain(
        `${binary} -A POCKETCODER_EGRESS -m owner --uid-owner 999 -j ACCEPT`,
      );
      expect(commands.at(-2)).toBe(`${binary} -A POCKETCODER_EGRESS -j REJECT`);
      expect(commands.at(-1)).toBe(`${binary} -I OUTPUT 1 -j POCKETCODER_EGRESS`);
    }
  });
});
