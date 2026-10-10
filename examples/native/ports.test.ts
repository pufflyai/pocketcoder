import { expect, test } from "bun:test";
import { controllerPorts } from "./ports";

test("controller ports stay distinct and reserved until both have been chosen", () => {
  const reservation = controllerPorts();
  const ports = [reservation.operator, reservation.agent];
  const probes: ReturnType<typeof Bun.serve>[] = [];
  try {
    expect(reservation.operator).not.toBe(reservation.agent);
    for (const port of ports) {
      expect(() => probes.push(Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("") }))).toThrow();
    }
  } finally {
    for (const probe of probes) probe.stop(true);
    reservation.release();
  }
  for (const port of ports) {
    const listener = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("") });
    listener.stop(true);
  }
});
