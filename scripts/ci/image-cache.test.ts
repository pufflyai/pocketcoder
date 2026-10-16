import { expect, test } from "bun:test";
import { imageBuildCommand } from "./image-cache";

test("local builds keep the normal Docker command", () => {
  expect(imageBuildCommand("server", "amd64", false, false)).toEqual(["docker", "build"]);
});

test.each(["desktop", "browser"])("%s uses the Docker builder that can see its host-loaded workspace base", (role) => {
  expect(imageBuildCommand(role, "arm64", true, false)).toEqual(["docker", "build", "--builder", "default"]);
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
