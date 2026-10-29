import { readFileSync } from "node:fs";
import type { AdmissionDecision } from "@pstdio/pocketcoder-contracts";
import type { WorkspaceRow } from "@pstdio/pocketcoder-runtime-core";
import { z } from "zod";

const CapacityDenial = z.object({
  allowed: z.literal(false),
  reason: z.literal("active-capacity"),
  scope: z.enum(["global", "actor"]),
});

export function launchPolicyConfig(env: Record<string, string | undefined>) {
  const url = env.POCKETCODER_LAUNCH_POLICY_URL;
  const tokenFile = env.POCKETCODER_LAUNCH_POLICY_TOKEN_FILE;
  if (!url && !tokenFile) return undefined;
  if (!url || !tokenFile) throw new Error("Launch policy requires both URL and token file");
  const parsed = new URL(url);
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
  if (
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    parsed.search ||
    (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback))
  ) {
    throw new Error("Launch policy requires HTTPS or a loopback HTTP endpoint");
  }
  return { url, tokenFile };
}

export function createLaunchPolicy(url: string, token: string) {
  return async (
    workspace: Pick<WorkspaceRow, "id" | "principalId" | "externalId" | "templateName" | "launchMode" | "metadata">,
  ): Promise<AdmissionDecision> => {
    try {
      const response = await fetch(url, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(5000),
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          workspace_id: workspace.id,
          principal_id: workspace.principalId,
          external_id: workspace.externalId,
          template_name: workspace.templateName,
          launch_mode: workspace.launchMode,
          metadata: workspace.metadata,
        }),
      });
      if (response.status === 403) {
        const denial = CapacityDenial.safeParse(await response.json());
        if (denial.success) {
          const reason =
            denial.data.scope === "global" ? "admission_policy_global_capacity" : "admission_actor_capacity";
          return { allowed: false, reason };
        }
        return { allowed: false, reason: "admission_denied" };
      }
      if (response.status !== 200) return { allowed: false, reason: "admission_unavailable" };
      const decision = await response.json();
      const allowed =
        typeof decision === "object" &&
        decision !== null &&
        "allowed" in decision &&
        decision.allowed === true &&
        "workspace_id" in decision &&
        decision.workspace_id === workspace.id;
      return allowed ? true : { allowed: false, reason: "admission_denied" };
    } catch {
      // Never log authorization headers, workspace metadata or response bodies.
      return { allowed: false, reason: "admission_unavailable" };
    }
  };
}

export function loadLaunchPolicy(config: ReturnType<typeof launchPolicyConfig>) {
  if (!config) return undefined;
  const token = readFileSync(config.tokenFile, "utf8").trim();
  if (token.length < 24 || /\s/.test(token)) throw new Error("Invalid launch policy control token");
  return createLaunchPolicy(config.url, token);
}
