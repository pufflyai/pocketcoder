import { randomBytes, randomUUID } from "node:crypto";
import type { PocketCoderClient, WorkspaceResource } from "@pstdio/pocketcoder-sdk";
import { waitFor } from "../e2e/local-process";
import type { OpenAIGatewayConfig } from "../harnesses/pi/openai-gateway";
import { workspaceGateway } from "./gateway";

export class ResumeSession {
  readonly generations: WorkspaceResource[] = [];
  readonly gateways: ReturnType<typeof workspaceGateway>[] = [];
  constructor(
    readonly client: PocketCoderClient,
    readonly gatewayConfig: Omit<OpenAIGatewayConfig, "clientBearer"> & { allowedModel: string },
    readonly api: "openai-completions" | "openai-responses",
  ) {}

  private gateway() {
    const gateway = workspaceGateway(this.client, this.gatewayConfig);
    this.gateways.push(gateway);
    return {
      gateway,
      input: {
        gateway: {
          url: gateway.url,
          bearer: gateway.bearer,
          model: this.gatewayConfig.allowedModel,
          api: this.api,
        },
      },
    };
  }

  async create() {
    const { gateway, input } = this.gateway();
    const workspace = await this.client.workspaces.create({
      externalId: `resume-test-${randomUUID()}`,
      templateName: "pi-resume",
      launchInput: input,
    });
    gateway.bind(workspace.id);
    this.generations.push(workspace);
    return this.client.workspaces.waitForReady(workspace, 300_000);
  }

  async resume(id: string, attemptId: string) {
    if (!this.generations.some((workspace) => workspace.id === id)) {
      throw new Error("Workspace is not part of this isolated session");
    }
    const { gateway, input } = this.gateway();
    const { workspace } = await this.client.workspaces.resume(
      id,
      {
        external_id: `resume-${attemptId}`,
        launch_input: input,
      },
      attemptId,
    );
    gateway.bind(workspace.id);
    this.generations.push(workspace);
    console.log(`Resuming ${id.slice(0, 8)} as ${workspace.id.slice(0, 8)}`);
    return workspace;
  }

  async preserve(id: string) {
    if (!this.generations.some((workspace) => workspace.id === id)) {
      throw new Error("Workspace is not part of this isolated session");
    }
    await this.client.workspaces.preserve(id, { label: "manual-test" }, randomUUID());
  }

  async detach() {
    const generation = this.generations.at(-1);
    if (!generation) throw new Error("No workspace in this session");
    const current = await this.client.workspaces.get(generation.id);
    if (["queued", "provisioning", "connected"].includes(current.state)) {
      await this.client.workspaces.waitForReady(current, 300_000);
    }
    const ready = await this.client.workspaces.get(generation.id);
    if (ready.state === "ready") await this.preserve(ready.id);
    await waitFor(
      async () => {
        const workspace = await this.client.workspaces.get(generation.id);
        if (["failed", "expired", "canceled", "succeeded"].includes(workspace.state)) {
          throw new Error(`Workspace cannot be preserved: ${workspace.state}`);
        }
        return workspace.state === "preserved";
      },
      120_000,
      "preserve before disconnect",
    );
  }

  controlServer(stop?: () => void) {
    const key = randomBytes(32).toString("base64url");
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        if (request.method !== "POST") return new Response("not found", { status: 404 });
        if (request.headers.get("authorization") !== `Bearer ${key}`) {
          return new Response("unauthorized", { status: 401 });
        }
        const body = (await request.json()) as { workspaceId: string; attemptId: string };
        try {
          const path = new URL(request.url).pathname;
          if (path === "/stop" && stop) {
            setTimeout(stop, 0);
            return Response.json({ ok: true });
          }
          if (path === "/attach") {
            const workspace = this.generations.at(-1);
            if (!workspace) throw new Error("No workspace in this session");
            return Response.json(await this.client.workspaces.get(workspace.id));
          }
          if (path === "/detach") {
            await this.detach();
            return Response.json({ ok: true });
          }
          if (path === "/resume")
            return Response.json(await this.resume(body.workspaceId, body.attemptId));
          if (path === "/preserve") {
            await this.preserve(body.workspaceId);
            return Response.json({ ok: true });
          }
          return new Response("not found", { status: 404 });
        } catch (error) {
          return new Response(String(error), { status: 400 });
        }
      },
    });
    return { key, url: `http://127.0.0.1:${server.port}`, close: () => server.stop(true) };
  }

  async close() {
    for (const gateway of this.gateways) gateway.close();
    for (const generation of this.generations) {
      const workspace = await this.client.workspaces.get(generation.id);
      if (["queued", "provisioning", "connected", "ready"].includes(workspace.state)) {
        await this.client.workspaces.cancel(workspace.id);
      }
      await waitFor(
        async () => {
          const current = await this.client.workspaces.get(workspace.id);
          return ["preserved", "canceled", "expired", "failed", "succeeded"].includes(
            current.state,
          );
        },
        60_000,
        "workspace cleanup",
      );
      const checkpoints = await this.client.checkpoints.list(workspace.id);
      for (const checkpoint of checkpoints.items) {
        if (checkpoint.state !== "ready") continue;
        const operation = await this.client.checkpoints.delete(checkpoint.id, randomUUID());
        await waitFor(
          async () => {
            const current = await this.client.operations.get(operation.id);
            if (current.state === "failed") throw new Error("Checkpoint cleanup failed");
            return current.state === "succeeded";
          },
          30_000,
          "checkpoint cleanup",
        );
      }
    }
  }
}
