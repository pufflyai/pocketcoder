import { expect, test } from "bun:test";
import { releaseImageTags } from "./release-images";

const registry = "ghcr.io/pufflyai/pocketcoder";

test("a release tag gives every role its version tag and latest", () => {
  const plan = releaseImageTags(registry, "v0.9.0", { latest: true });
  expect(plan.map((entry) => entry.role)).toEqual(["server", "workspace", "desktop", "browser", "egress", "manager"]);
  expect(plan[0]).toEqual({
    role: "server",
    tags: [`${registry}/server:0.9.0`, `${registry}/server:latest`],
  });
});

test("latest stays where it is when the release should not move it", () => {
  const plan = releaseImageTags(registry, "v0.8.2", { latest: false });
  expect(plan.every((entry) => entry.tags.length === 1)).toBe(true);
  expect(plan[4].tags).toEqual([`${registry}/egress:0.8.2`]);
});

test("only plain release tags and the project's registry are accepted", () => {
  for (const tag of ["0.9.0", "v0.9", "v1.0.0-rc.1", "main"])
    expect(() => releaseImageTags(registry, tag, { latest: true })).toThrow("release tag");
  expect(() => releaseImageTags("docker.io/pufflyai/pocketcoder", "v0.9.0", { latest: true })).toThrow("GHCR");
});
