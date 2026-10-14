import { expect, test } from "bun:test";
import { createLaunchPolicy } from "./launch-policy";

test.each([
  [403, { allowed: false, reason: "active-capacity", scope: "global" }, "admission_policy_global_capacity"],
  [403, { allowed: false, reason: "active-capacity", scope: "actor" }, "admission_actor_capacity"],
  [403, { allowed: false, reason: "private-policy-detail" }, "admission_denied"],
  [503, { reason: "active-capacity", scope: "global" }, "admission_unavailable"],
] as const)("launch policy reports a bounded reason for HTTP %s: %j", async (status, body, reason) => {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => Response.json(body, { status }),
  });
  try {
    const authorize = createLaunchPolicy(server.url.toString(), "synthetic-control-token");
    expect(
      await authorize({
        id: "generation",
        principalId: "principal",
        externalId: "task",
        templateName: "template",
        launchMode: "create",
        metadata: {},
      }),
    ).toEqual({ allowed: false, reason });
  } finally {
    server.stop(true);
  }
});

test.each(["allow", "deny", "wrong-workspace", "unavailable", "redirect", "malformed"])(
  "launch policy requires an explicit matching response: %s",
  async (mode) => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        expect(request.headers.get("authorization")).toBe("Bearer synthetic-control-token");
        const body = (await request.json()) as { workspace_id: string };
        expect(body.workspace_id).toBe("generation");
        expect(body).not.toHaveProperty("launchInput");
        if (mode === "unavailable") return new Response("unavailable", { status: 503 });
        if (mode === "redirect") return new Response(null, { status: 302, headers: { location: "/other" } });
        if (mode === "malformed") return new Response("not json");
        return Response.json({
          allowed: mode !== "deny",
          workspace_id: mode === "wrong-workspace" ? "other" : "generation",
        });
      },
    });
    try {
      const authorize = createLaunchPolicy(server.url.toString(), "synthetic-control-token");
      const workspace = {
        id: "generation",
        principalId: "principal",
        externalId: "task",
        templateName: "template",
        launchMode: "create" as const,
        metadata: {},
        launchInput: { bootstrap_code: "never-forward" },
      };
      const result = await authorize(workspace);
      if (mode === "allow") expect(result).toBe(true);
      else
        expect(result).toEqual({
          allowed: false,
          reason: mode === "deny" || mode === "wrong-workspace" ? "admission_denied" : "admission_unavailable",
        });
    } finally {
      server.stop(true);
    }
  },
);
