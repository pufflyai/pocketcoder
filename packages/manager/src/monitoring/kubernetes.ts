import { ControllerHealthSchema } from "@pstdio/pocketcoder-server/monitoring";
import type { Account } from "../database/store";
import { kube } from "../kubernetes/command";
import { privateControllerRequest } from "../kubernetes/private-controller";
import { cellCapacity } from "./cell";

export function monitoringProbes(
  directory: string,
  command = (args: string[], input?: string) => kube(args, input, 8000),
) {
  return {
    directory,
    account: async (account: Account) =>
      ControllerHealthSchema.parse(await privateControllerRequest(command, account, "/v1/monitoring")),
    cell: async () => {
      const [nodes, pods] = await Promise.all([
        command(["get", "nodes", "-o", "json"]),
        command(["get", "pods", "--all-namespaces", "-o", "json"]),
      ]);
      return cellCapacity(JSON.parse(nodes), JSON.parse(pods));
    },
  };
}
