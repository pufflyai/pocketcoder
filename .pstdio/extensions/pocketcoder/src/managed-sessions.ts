import { randomUUID } from "node:crypto";
import type { managed, PocketCoderClient } from "@pstdio/pocketcoder-sdk";
import { commandRef, defineCommand, params } from "@pstdio/sdk/extensions";
import { instancesFor } from "./instances";
import { machineSessionTarget } from "./machine-session";
import { managedBindings } from "./managed-bindings";
import { changed } from "./resources";
import { sessionMessages } from "./session-messages";

const ref = (id: string) => commandRef({ extensionId: "pocketcoder.pocketcoder", id });
export const renderManagedMessages = (messages: managed.SessionMessage[]) =>
  sessionMessages(
    messages.map((m) => ({
      message_id: m.messageId,
      role: m.role,
      content: m.parts
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join(""),
      parts: m.parts,
      occurred_at: m.occurredAt,
      metadata: {},
    })),
  );
export async function readManagedMessages(client: PocketCoderClient, sessionId: string, signal?: AbortSignal) {
  return renderManagedMessages((await client.sessions.conversation(sessionId, {}, { signal })).messages);
}

export const createOpenManagedSessions = (getInstances = instancesFor, getBindings = managedBindings) =>
  defineCommand({
    id: "sessions.open",
    title: "Open managed sessions",
    cli: true,
    mutating: true,
    params: {
      instance: params.select({
        label: "PocketCoder instance",
        required: true,
        options: { command: ref("instances.choices"), valueField: "value", labelField: "label" },
      }),
      template: params.select({
        label: "Agent template",
        required: true,
        options: {
          command: ref("templates.choices"),
          valueField: "value",
          labelField: "label",
          params: { instance: params.valueOf("instance") },
        },
      }),
      count: params.number({ label: "Sessions", defaultValue: 2 }),
    },
    async run(ctx, input) {
      const count = Math.min(5, Math.max(1, Math.trunc(input.count ?? 2)));
      const instances = getInstances(ctx.projectId);
      const operator = await instances.client(input.instance);
      const separator = input.template.lastIndexOf("@");
      const [name, version] = [input.template.slice(0, separator), input.template.slice(separator + 1)];
      const template = (await operator.templates.list()).find((row) => row.name === name && row.version === version);
      if (!template) throw new Error("Choose an active versioned agent template.");
      const profile = await instances.configureManagedProfile(input.instance, `${name}-${version}`, name, version);
      const client = await instances.managedClient(input.instance);
      const opened = [];
      for (let index = 0; index < count; index++) {
        const managedSessionId = randomUUID();
        await client.sessions.create({ sessionId: managedSessionId, profile, owner: "lab" });
        // Resume asks for compute now, so the placement shows in Machines before the first message.
        await client.sessions.resume(managedSessionId);
        // A controller session without a Lab chat would hold a slot nobody can reach, so it is closed.
        const session = await (async () => {
          const chat = await ctx.sessions.create({
            title: `Managed ${name}: ${managedSessionId.slice(0, 8)}`,
            harness: { harnessId: `${ctx.extensionId}.harness.managed` },
          });
          await getBindings(ctx.projectId).bind(chat.id, input.instance, managedSessionId);
          return chat;
        })().catch(async (error: unknown) => {
          await client.sessions.close(managedSessionId).catch(() => {});
          throw error;
        });
        opened.push({ sessionId: session.id, managedSessionId });
        if (index === count - 1) ctx.navigation.open(machineSessionTarget(ctx.projectId, session));
      }
      await ctx.events.emit(changed, {});
      return { instanceId: input.instance, profile, sessions: opened };
    },
  });

export const openManagedSessions = createOpenManagedSessions();
