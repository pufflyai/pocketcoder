import { describe, expect, test } from "bun:test";
import { doctorCommand, runDoctorCheck } from "./doctor-check";

const options = {
  baseUrl: "http://127.0.0.1:7080",
  key: "pkt_example",
  template: "pi-harness",
};

describe("doctor CI check", () => {
  test("targets the template and bounds the probe", () => {
    expect(doctorCommand("pi-harness", 90)).toEqual([
      "bun",
      "packages/cli/src/index.ts",
      "doctor",
      "--template",
      "pi-harness",
      "--turn-timeout-seconds",
      "90",
    ]);
  });

  test("passes the stack credentials through the environment", async () => {
    let seen: Record<string, string> = {};
    await runDoctorCheck(options, async (_args, env) => {
      seen = env;
      return { stdout: "doctor: ok" };
    });

    expect(seen).toEqual({
      POCKETCODER_URL: "http://127.0.0.1:7080",
      POCKETCODER_KEY: "pkt_example",
    });
  });

  // Doctor prints its progress before it fails, so the presence of output is
  // not proof that the correlated turn completed.
  test("fails when doctor never reports ok", async () => {
    const failure = await runDoctorCheck(options, async () => ({
      stdout: "doctor: workspace ready; probing agent status through the relay",
    })).catch((error: unknown) => error);

    expect(String(failure)).toContain("doctor did not report ok for template pi-harness");
  });
});
