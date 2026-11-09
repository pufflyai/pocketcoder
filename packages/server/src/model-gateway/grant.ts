import type { ManagedRuntimeStore } from "@pstdio/pocketcoder-runtime-core";

// Port types derived from the exported store, so the gateway follows the budget owner's contract.
export type GatewayBudgets = ManagedRuntimeStore["budgets"];
export type GatewayInvocation = Parameters<GatewayBudgets["reserve"]>[0];
export type ManagedInvocationIdentity = GatewayInvocation["identity"];
export type ManagedRequestIdentity = Omit<ManagedInvocationIdentity, "invocationId">;

// The grant owner (PC-175) resolves a workspace bearer and the physical turn the producer is running
// to that turn's logical request, on the workspace's current physical incarnation.
export interface GatewayGrant {
  identity: ManagedRequestIdentity;
  workspaceId: string;
  incarnationId: string;
  generation: number;
  allowedModels: string[];
}
export type ResolveGrant = (bearer: string, turnId: string | null) => Promise<GatewayGrant>;
// The producer names the physical turn it is running; the controller allocated it and maps it back.
export const GATEWAY_TURN_HEADER = "x-pocketcoder-turn";
