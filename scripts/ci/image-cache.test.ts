import { expect, test } from "bun:test";
import { imageBuildCommand } from "./image-cache";

test("local builds keep the normal Docker command", () => {
  expect(imageBuildCommand("server", "amd64", false, false)).toEqual(["docker", "build"]);
});

test("queue builds can restore layers without publishing shared cache results", () => {
  const args = imageBuildCommand("server", "arm64", true, false);
  expect(args).toContain("--load");
  expect(args).toContain("type=gha,scope=candidate-server-arm64");
  expect(args).not.toContain("--cache-to");
});

test("trusted cache writers retain separate image role and architecture scopes", () => {
  expect(imageBuildCommand("workspace", "amd64", true, true)).toContain(
    "type=gha,scope=candidate-workspace-amd64,mode=max",
  );
});

test("derived roles use the daemon image store that holds their same-run workspace parent", () => {
  for (const role of ["desktop", "browser"]) {
    const args = imageBuildCommand(role, "arm64", true, true);
    expect(args.slice(0, 2)).toEqual(["docker", "build"]);
    expect(args).not.toContain("--cache-from");
    expect(args).not.toContain("--cache-to");
  }
});
