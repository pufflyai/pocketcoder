import { readFile } from "node:fs/promises";
import { managed } from "@pstdio/pocketcoder-contracts";
import type { Argv } from "yargs";
import { controlPlaneClient, need } from "../../command/cli-context";
import { addAction, addResource } from "../command";

const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
const scopeOption = (command: Argv) =>
  command.option("scope", { type: "string", demandOption: true, description: "Budget scope ID" });
const json = async (path: string) => JSON.parse(await readFile(path, "utf8")) as unknown;

// Managed authority and physical capacity budgets. Model usage belongs to the model gateway.
export function addBudgetCommands(parser: Argv) {
  return addResource(parser, "budgets", "Provision managed authority and capacity budgets", (commands) => {
    let configured = addAction(
      commands,
      "grant",
      "Grant a budget scope to a principal",
      (command) =>
        scopeOption(command).option("principal", { type: "string", demandOption: true }).option("installation", {
          type: "boolean",
          default: false,
          description: "The controller's installation scope",
        }),
      async (flags) => {
        await controlPlaneClient().authority.grantScope(need(flags, "scope"), {
          principalId: need(flags, "principal"),
          installation: flags.installation === true,
        });
        print({ scopeId: flags.scope, principalId: flags.principal, granted: true });
      },
    );
    configured = addAction(
      configured,
      "set-policy",
      "Write a capacity policy revision from a JSON file",
      (command) =>
        command
          .option("file", { type: "string", demandOption: true, description: "BudgetPolicyWrite JSON" })
          .option("expected-revision", { type: "number", description: "Current revision; omit for the first one" }),
      async (flags) => {
        const policy = managed.BudgetPolicyWriteSchema.parse(await json(need(flags, "file")));
        const expected = typeof flags["expected-revision"] === "number" ? flags["expected-revision"] : null;
        print(await controlPlaneClient().authority.putPolicy(policy, expected));
      },
    );
    configured = addAction(configured, "policy", "Get a scope's current policy", scopeOption, async (flags) => {
      print(await controlPlaneClient().authority.getPolicy(need(flags, "scope")));
    });
    configured = addAction(configured, "usage", "Get a scope's capacity usage", scopeOption, async (flags) => {
      print(await controlPlaneClient().authority.usage(need(flags, "scope")));
    });
    configured = addAction(
      configured,
      "profile",
      "Provision an immutable execution profile revision from a JSON file",
      (command) =>
        command
          .option("principal", { type: "string", demandOption: true })
          .option("file", { type: "string", demandOption: true, description: "ExecutionProfile JSON" }),
      async (flags) => {
        const profile = managed.ExecutionProfileSchema.parse(await json(need(flags, "file")));
        print(await controlPlaneClient().authority.putProfile(need(flags, "principal"), profile));
      },
    );
    return addAction(
      configured,
      "credential-binding",
      "Register a business credential binding from a JSON file",
      (command) =>
        command.option("file", { type: "string", demandOption: true, description: "CredentialBinding JSON" }),
      async (flags) => {
        const binding = managed.managedSchemas.CredentialBinding.parse(await json(need(flags, "file")));
        await controlPlaneClient().authority.putCredentialBinding(binding);
        print({ bindingId: binding.bindingId, registered: true });
      },
    );
  });
}
