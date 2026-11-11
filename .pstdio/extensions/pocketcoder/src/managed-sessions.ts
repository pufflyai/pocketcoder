import { randomUUID } from "node:crypto";
import type { ConversationMessageInput, managed, PocketCoderClient } from "@pstdio/pocketcoder-sdk";
import { commandRef, defineCommand, params } from "@pstdio/sdk/extensions";
import { instancesFor } from "./instances";
import { machineSessionTarget } from "./machine-session";
import { managedBindings } from "./managed-bindings";
import { changed } from "./resources";
import { sessionMessages } from "./session-messages";

type Profile = { profileId: string; revision: number };
type Storage = { get<T>(key: string): Promise<T | undefined>; set(key: string, value: unknown): Promise<void> };

const ref = (id: string) => commandRef({ extensionId: "pocketcoder.pocketcoder", id });

// Lab capacity: up to five sessions share one machine, and an instance runs at most four managed
// machines. Model spend is not a PocketCoder budget.
const LAB_LIMITS = { workspaceStarts: 100, maxActiveWorkspaces: 4, maxChatProcessesPerWorkspace: 5 };

async function grantScope(client: PocketCoderClient, principalId: string, installation: boolean) {
  const scopeId = randomUUID();
  await client.authority.grantScope(scopeId, { principalId, installation });
  await client.authority.putPolicy(
    { scopeId, revision: 1, period: "utc_day", limits: { ...LAB_LIMITS, maxRunningRequestsPerSession: 1 } },
    null,
  );
  return scopeId;
}

// One profile per instance and template digest. It has no credential binding, so its sessions share
// machines; a template that names credentials needs a binding and is refused by the controller.
export async function labProfile(
  storage: Storage,
  client: PocketCoderClient,
  instanceId: string,
  templateDigest: string,
): Promise<Profile> {
  const key = `managed-profile:${instanceId}:${templateDigest}`;
  const known = await storage.get<Profile>(key);
  if (known) return known;
  const owner = (await client.principals.list()).items.find((principal) => principal.name === "owner");
  if (!owner) throw new Error("This instance has no owner principal.");
  const installationKey = `managed-installation-scope:${instanceId}`;
  let installation = await storage.get<string>(installationKey);
  if (!installation) {
    installation = await grantScope(client, owner.id, true);
    await storage.set(installationKey, installation);
  }
  const profile = await client.authority
    .putProfile(owner.id, {
      profileId: randomUUID(),
      revision: 1,
      isolationScopeId: randomUUID(),
      budgetScopeIds: [installation, await grantScope(client, owner.id, false)],
      templateDigest,
      credentialBindingId: null,
    })
    .catch((error: unknown) => {
      throw new Error(`Managed Lab sessions need a template without credentials. ${String(error)}`);
    });
  const saved = { profileId: profile.profileId, revision: profile.revision };
  await storage.set(key, saved);
  return saved;
}

type Message = ConversationMessageInput;

// Every committed message of the session, oldest first.
export async function historyMessages(client: PocketCoderClient, sessionId: string, signal?: AbortSignal) {
  const messages: Message[] = [];
  let cursor: string | undefined;
  do {
    const page: managed.HistoryPage = await client.sessions.history(sessionId, { cursor, limit: 200 }, { signal });
    for (const record of page.records) messages.push(...record.messages);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return messages;
}

// Messages of turns that are still running and not committed yet.
export async function openMessages(client: PocketCoderClient, sessionId: string, signal?: AbortSignal) {
  const turns = (await client.sessions.open(sessionId, { signal })).turns;
  return turns.flatMap((turn) => (turn.type === "turn" ? (turn.messages as Message[]) : []));
}

export function renderMessages(committed: Message[], live: Message[]) {
  const messages = new Map(committed.map((message) => [message.message_id, message]));
  for (const message of live) if (!messages.has(message.message_id)) messages.set(message.message_id, message);
  return sessionMessages(
    [...messages.values()].sort(
      (a, b) =>
        Date.parse(a.occurred_at) - Date.parse(b.occurred_at) ||
        (a.identity?.sequence ?? 0) - (b.identity?.sequence ?? 0),
    ),
  );
}

// Retained history plus the live turn, so a running answer shows before it is committed.
export async function readManagedMessages(client: PocketCoderClient, sessionId: string, signal?: AbortSignal) {
  return renderMessages(
    await historyMessages(client, sessionId, signal),
    await openMessages(client, sessionId, signal),
  );
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
      const client = await instances.client(input.instance);
      const separator = input.template.lastIndexOf("@");
      const [name, version] = [input.template.slice(0, separator), input.template.slice(separator + 1)];
      const template = (await client.templates.list()).find((row) => row.name === name && row.version === version);
      if (!template) throw new Error("Choose an active versioned agent template.");
      const profile = await labProfile(ctx.storage, client, input.instance, template.digest);
      const opened = [];
      for (let index = 0; index < count; index++) {
        // Sessions join a machine only after one of this template has registered and shown it runs
        // conversations side by side, so the rest wait for the first session's machine.
        if (index === 1) await ready(client, opened[0]?.managedSessionId ?? "");
        const managedSessionId = randomUUID();
        await client.sessions.create({ sessionId: managedSessionId, ...profileRef(profile) });
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
          await client.sessions.close(managedSessionId, { cancelId: randomUUID() }).catch(() => {});
          throw error;
        });
        opened.push({ sessionId: session.id, managedSessionId });
        if (index === count - 1) ctx.navigation.open(machineSessionTarget(ctx.projectId, session));
      }
      await ctx.events.emit(changed, {});
      return { instanceId: input.instance, profileId: profile.profileId, sessions: opened };
    },
  });

export const openManagedSessions = createOpenManagedSessions();

const profileRef = (profile: Profile) => ({ profileId: profile.profileId, profileRevision: profile.revision });

async function ready(client: PocketCoderClient, sessionId: string) {
  const deadline = Date.now() + 180_000;
  while (true) {
    const session = await client.sessions.get(sessionId);
    if (session.state === "ready") return;
    if (session.state === "failed" || session.state === "closed")
      throw new Error(`The first session is ${session.state}${session.reasonCode ? `: ${session.reasonCode}` : ""}.`);
    if (Date.now() > deadline) throw new Error("The first session's machine did not become ready.");
    await Bun.sleep(1000);
  }
}
