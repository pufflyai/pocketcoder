import { describe, expect, test } from "bun:test";
import { loadPocketcoderSnapshot, type ProcessRunner } from "./snapshot";

const processRunner = (
  responses: Record<string, { exitCode: number; stdout?: string; stderr?: string }>,
): ProcessRunner => ({
  async run(input) {
    const key = input.command.slice(4).join(" ");
    const response = responses[key];
    if (!response) throw new Error(`Unexpected command: ${input.command.join(" ")}`);
    return {
      exitCode: response.exitCode,
      stdout: response.stdout ?? "",
      stderr: response.stderr ?? "",
    };
  },
});

describe("loadPocketcoderSnapshot", () => {
  test("loads active workspaces and authorized templates from the repo CLI", async () => {
    const runner = processRunner({
      "workspaces list --active --json": {
        exitCode: 0,
        stdout: JSON.stringify([
          {
            id: "workspace-1",
            external_id: "PC-42",
            state: "ready",
            reason_code: null,
            template: { name: "pi-harness", version: "1.2.0" },
          },
        ]),
      },
      "templates list --json": {
        exitCode: 0,
        stdout: JSON.stringify([
          {
            name: "pi-harness",
            version: "1.2.0",
            status: "active",
            digest: "sha256:1234567890",
          },
        ]),
      },
    });

    const snapshot = await loadPocketcoderSnapshot({
      process: runner,
      repoPath: "/repo",
      now: () => new Date("2026-07-30T12:00:00.000Z"),
    });

    expect(snapshot).toEqual({
      refreshedAt: "2026-07-30T12:00:00.000Z",
      workspaces: [
        {
          id: "workspace-1",
          external_id: "PC-42",
          state: "ready",
          reason_code: null,
          template: { name: "pi-harness", version: "1.2.0" },
        },
      ],
      templates: [
        {
          name: "pi-harness",
          version: "1.2.0",
          status: "active",
          digest: "sha256:1234567890",
        },
      ],
      errors: [],
    });
  });

  test("keeps successful template data when workspace discovery fails", async () => {
    const runner = processRunner({
      "workspaces list --active --json": {
        exitCode: 1,
        stderr: "pcd: POCKETCODER_KEY is required for this command",
      },
      "templates list --json": {
        exitCode: 0,
        stdout: JSON.stringify([
          {
            name: "echo-harness",
            version: "1.0.0",
            status: "available",
            digest: "sha256:abcdef",
          },
        ]),
      },
    });

    const snapshot = await loadPocketcoderSnapshot({
      process: runner,
      repoPath: "/repo",
      now: () => new Date("2026-07-30T12:00:00.000Z"),
    });

    expect(snapshot.workspaces).toEqual([]);
    expect(snapshot.templates).toHaveLength(1);
    expect(snapshot.errors).toEqual([
      {
        source: "workspaces",
        message: "pcd: POCKETCODER_KEY is required for this command",
      },
    ]);
  });
});
