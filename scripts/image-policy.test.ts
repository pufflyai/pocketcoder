import { expect, test } from "bun:test";
import { assertImageScan, assertImageSet } from "./image-policy";

test("the release gate rejects HIGH findings even without an upstream fix", () => {
  const scan = {
    SchemaVersion: 2,
    Results: [
      {
        Target: "alpine",
        Vulnerabilities: [{ VulnerabilityID: "CVE-2026-57980", Severity: "HIGH", Status: "will_not_fix" }],
      },
    ],
  };
  expect(() => assertImageScan(scan)).toThrow("CVE-2026-57980");
});

test("the release gate rejects CRITICAL findings and missing scan results", () => {
  expect(() =>
    assertImageScan({
      SchemaVersion: 2,
      Results: [{ Target: "agentapi", Vulnerabilities: [{ VulnerabilityID: "critical", Severity: "CRITICAL" }] }],
    }),
  ).toThrow("critical");
  expect(() => assertImageScan({ SchemaVersion: 2 })).toThrow("results");
  expect(() => assertImageScan({ SchemaVersion: 2, Results: [{ Target: "alpine" }] })).not.toThrow();
});

test("publication requires every role on both architectures from the same commit", () => {
  const commit = "a".repeat(40);
  const records = ["server", "workspace", "desktop", "browser", "egress", "manager"].flatMap((role) =>
    ["amd64", "arm64"].map((arch) => ({ role, arch, commit, channel: "candidate", result: "passed" })),
  );
  expect(() => assertImageSet(records, commit)).not.toThrow();
  expect(() => assertImageSet(records.slice(1), commit)).toThrow("server/amd64");
  expect(() =>
    assertImageSet(
      [...records, { role: "server", arch: "amd64", commit, channel: "candidate", result: "passed" }],
      commit,
    ),
  ).toThrow("Duplicate");
  expect(() =>
    assertImageSet(
      records.map((r) => ({ ...r, commit: "b".repeat(40) })),
      commit,
    ),
  ).toThrow("commit");
  expect(() =>
    assertImageSet(
      records.map((r) => ({ ...r, channel: "latest" })),
      commit,
    ),
  ).toThrow("candidate");
});

test("publication refuses scan-only evidence before writing to the registry", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { imageArchitectures, imageRoles } = await import("./image-policy");
  const { publishCandidateImages } = await import("./publish-candidate-images");
  const directory = await mkdtemp(join(tmpdir(), "pc-image-publication-"));
  const commit = "a".repeat(40);
  try {
    for (const role of imageRoles) {
      for (const arch of imageArchitectures) {
        await Bun.write(
          join(directory, `${role}-${arch}.json`),
          JSON.stringify({
            role,
            arch,
            commit,
            channel: "candidate",
            result: "passed",
            scanner: { Version: "0.74.0", VulnerabilityDB: { UpdatedAt: "2026-10-10T18:59:50Z" } },
          }),
        );
      }
    }
    await expect(publishCandidateImages(directory, commit, "ghcr.io/pufflyai/pocketcoder")).rejects.toThrow(
      "smoke is missing",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("GNU runtime coverage rejects Alpine-only results and omitted native libraries", async () => {
  const { assertGlibcCoverage } = await import("./image-rootfs");
  const report = {
    SchemaVersion: 2,
    Metadata: { OS: { Family: "debian" } },
    Results: [
      {
        Target: "GNU runtime",
        Type: "debian",
        Packages: ["libc6", "libstdc++6", "libgcc-s1", "libgomp1", "libssl3t64", "zlib1g", "libzstd1"].map((Name) => ({
          Name,
          Version: "patched",
          Arch: "arm64",
        })),
      },
    ],
  };
  expect(() => assertGlibcCoverage(report)).not.toThrow();
  expect(() => assertGlibcCoverage({ ...report, Metadata: { OS: { Family: "alpine" } } })).toThrow("Debian matching");
  expect(() =>
    assertGlibcCoverage({ ...report, Results: [{ Target: "GNU runtime", Type: "debian", Packages: [] }] }),
  ).toThrow("libc6");
});

test("publication binds every primary scan, SBOM and scanner report before registry writes", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { imageArchitectures, imageRoles } = await import("./image-policy");
  const { publishCandidateImages } = await import("./publish-candidate-images");
  const directory = await mkdtemp(join(tmpdir(), "pc-image-evidence-"));
  const commit = "a".repeat(40);
  try {
    for (const missing of [".scan.json", ".sbom.cdx.json", ".scanner.json"]) {
      for (const role of imageRoles) {
        for (const arch of imageArchitectures) {
          const prefix = `${role}-${arch}`;
          await Bun.write(
            join(directory, `${prefix}.json`),
            JSON.stringify({
              role,
              arch,
              commit,
              channel: "candidate",
              result: "passed",
              smoke: { file: `${arch}.smoke.json`, sha256: "unread" },
              scanner: { Version: "0.74.0", VulnerabilityDB: { UpdatedAt: "2026-10-10T18:59:50Z" } },
              evidence: [".scan.json", ".sbom.cdx.json", ".scanner.json"]
                .filter((suffix) => role !== "server" || arch !== "amd64" || suffix !== missing)
                .map((suffix) => ({ file: `${prefix}${suffix}`, sha256: "unread" })),
            }),
          );
        }
      }
      await expect(publishCandidateImages(directory, commit, "ghcr.io/pufflyai/pocketcoder")).rejects.toThrow(
        `Primary image evidence is missing: server-amd64${missing}`,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
