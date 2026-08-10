import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  agentApiHarness,
  parseTemplateManifest,
  templateServices,
} from "@pstdio/pocketcoder-contracts";
import { OSS_E2E_HARNESSES } from "./oss";

describe("OSS harness E2E matrix", () => {
  test("runs Codex and OpenCode", () => {
    expect(OSS_E2E_HARNESSES).toEqual(["codex", "opencode"]);
  });

  for (const harness of ["codex", "opencode"] as const) {
    test(`${harness} template uses its native AgentAPI adapter and live event route`, async () => {
      const path = resolve(import.meta.dir, `../templates/${harness}-harness.json`);
      const manifest = JSON.parse(await readFile(path, "utf8")) as unknown;
      const spec = parseTemplateManifest(manifest).manifest.spec;

      expect(agentApiHarness(spec).command.slice(0, 4)).toEqual([
        "/usr/local/bin/agentapi",
        "server",
        "--type",
        harness,
      ]);
      if (harness === "opencode") {
        expect(agentApiHarness(spec).command).toContain("--experimental-acp");
      }
      expect(templateServices(spec).agent?.routes).toContainEqual(
        expect.objectContaining({ method: "GET", path: "/events", responseMode: "stream" }),
      );
    });
  }
});
