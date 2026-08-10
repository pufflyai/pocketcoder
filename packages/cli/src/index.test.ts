import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { runCli } from "./cli-test-support";

describe("pcd version", () => {
  test("prints the published package version", async () => {
    const { version } = await Bun.file(resolve(import.meta.dir, "../package.json")).json();
    const result = await runCli(["--version"]);

    expect(result.exitCode).toBe(0);
    expect(result.output.trim()).toBe(version);
  });

  test("leaves --version to the template version on workspaces create", async () => {
    const result = await runCli(["workspaces", "create", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Template version");
    expect(result.output).not.toContain("Show version number");
  });
});

describe("pcd help", () => {
  test("prints root help successfully", async () => {
    const result = await runCli(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("pcd <command>");
    expect(result.output).toContain("pcd workspaces <command>");
  });

  test("a missing root command prints help and fails", async () => {
    const result = await runCli([]);

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("pcd <command>");
    expect(result.output).toContain("A command is required.");
  });

  test.each(["server", "db", "principals", "keys", "templates", "pools", "workspaces"])(
    "a missing %s subcommand prints group help and fails",
    async (group) => {
      const result = await runCli([group]);

      expect(result.exitCode).toBe(1);
      expect(result.output).toContain(`pcd ${group} <command>`);
      expect(result.output).toContain("Not enough non-option arguments");
    },
  );

  test.each([
    {
      args: ["principals", "create"],
      usage: "pcd principals create",
      error: "Missing required arguments: name, scopes",
    },
    {
      args: ["principals", "update"],
      usage: "pcd principals update",
      error: "Missing required arguments: name, scopes",
    },
    {
      args: ["keys", "issue"],
      usage: "pcd keys issue",
      error: "Missing required argument: principal",
    },
    {
      args: ["keys", "revoke"],
      usage: "pcd keys revoke",
      error: "Missing required argument: id",
    },
    {
      args: ["templates", "validate"],
      usage: "pcd templates validate <files..>",
      error: "Not enough non-option arguments",
    },
    {
      args: ["workspaces", "create"],
      usage: "pcd workspaces create",
      error: "Missing required argument: template",
    },
    {
      args: ["workspaces", "get"],
      usage: "pcd workspaces get",
      error: "Missing required argument: id",
    },
    {
      args: ["workspaces", "logs"],
      usage: "pcd workspaces logs",
      error: "Missing required argument: id",
    },
    {
      args: ["workspaces", "network-events"],
      usage: "pcd workspaces network-events",
      error: "Missing required argument: id",
    },
    {
      args: ["workspaces", "terminal"],
      usage: "pcd workspaces terminal",
      error: "Missing required argument: id",
    },
    {
      args: ["workspaces", "terminal-sessions"],
      usage: "pcd workspaces terminal-sessions",
      error: "Missing required argument: id",
    },
    {
      args: ["workspaces", "cancel"],
      usage: "pcd workspaces cancel",
      error: "Missing required argument: id",
    },
    {
      args: ["doctor"],
      usage: "pcd doctor",
      error: "Missing required argument: template",
    },
  ])(
    "$usage prints command help when required arguments are missing",
    async ({ args, usage, error }) => {
      const result = await runCli(args);

      expect(result.exitCode).toBe(1);
      expect(result.output).toContain(usage);
      expect(result.output).toContain("Options:");
      expect(result.output).toContain(error);
    },
  );
});
