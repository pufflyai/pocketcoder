import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { issueMachineKey } from "@pstdio/pocketcoder-auth";
import { managedFixture, provisionManaged } from "@pstdio/pocketcoder-db/testing";
import { FilesystemInputStorage } from "@pstdio/pocketcoder-drivers";
import { DEFAULT_LIMITS } from "@pstdio/pocketcoder-runtime-core";
import { buildServer } from "@pstdio/pocketcoder-server";
import { FakeDriver } from "@pstdio/pocketcoder-testkit";
import { runCli } from "./cli-test-support";

// `submit` prints its intent on stderr before sending, so a caller can replay it exactly.
const withoutIntent = (output: string) =>
  JSON.parse(
    output
      .split("\n")
      .filter((line) => !line.startsWith('{"submit"'))
      .join("\n"),
  );

test("session and budget commands drive the managed API without opening the database", async () => {
  const f = await managedFixture();
  const directory = await mkdtemp(join(tmpdir(), "pc-cli-sessions-"));
  const pepper = "cli-sessions-test-pepper";
  const key = issueMachineKey(pepper);
  await f.store.insertMachineKey({
    id: key.id,
    principalId: f.principal.id,
    secretDigest: key.secretDigest,
    scopes: [],
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 120_000),
    revokedAt: null,
    lastUsedAt: null,
  });
  await provisionManaged(f);
  const built = buildServer({
    store: f.store,
    driver: new FakeDriver(),
    pepper,
    limits: DEFAULT_LIMITS,
    workspaceServerUrl: "http://127.0.0.1:0",
    sessionQueueLimits: { count: 4, bytes: 1048576 },
    sessionStopSeconds: 30,
    sessionEventPollMs: 10,
    inputStorageOptions: {
      driver: new FilesystemInputStorage(directory, []),
      limits: {
        fileBytes: 1048576,
        stagedBytes: 8388608,
        files: 16,
        transfers: 2,
        transferMs: 1000,
        retentionMs: 600000,
      },
      capacity: async () => ({
        workspace: { bytes: 8388608, files: 16 },
        principal: { bytes: 16777216, files: 32 },
        instance: { bytes: 33554432, files: 64 },
        freeDisk: { bytes: 67108864, files: 128, headroomBytes: 0, headroomFiles: 0 },
      }),
    },
  });
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: built.app.fetch });
  const env = { POCKETCODER_URL: listener.url.origin, POCKETCODER_KEY: key.token };
  const cli = async (args: string[]) => {
    const result = await runCli(args, { env });
    expect(result.exitCode).toBe(0);
    return result.output;
  };
  const json = async (args: string[]) => JSON.parse(await cli(args));
  try {
    const scopeId = randomUUID();
    await cli(["budgets", "grant", "--scope", scopeId, "--principal", f.principal.id]);
    const policyFile = join(directory, "policy.json");
    const policy = {
      scopeId,
      revision: 1,
      period: "utc_day",
      limits: {
        workspaceStarts: 2,
        maxActiveWorkspaces: 1,
        maxRunningRequestsPerSession: 1,
        maxChatProcessesPerWorkspace: 1,
      },
    };
    await writeFile(policyFile, JSON.stringify(policy));
    expect((await json(["budgets", "set-policy", "--file", policyFile])).revision).toBe(1);
    await writeFile(policyFile, JSON.stringify({ ...policy, revision: 2 }));
    expect((await json(["budgets", "set-policy", "--file", policyFile, "--expected-revision", "1"])).revision).toBe(2);
    expect((await json(["budgets", "policy", "--scope", scopeId])).revision).toBe(2);
    expect(await json(["budgets", "usage", "--scope", f.scopeId])).toMatchObject({ scopeId: f.scopeId });

    const sessionId = f.sessionId;
    expect((await json(["sessions", "get", "--session", sessionId])).state).toBe("provisioning");
    const notes = join(directory, "notes.txt");
    await writeFile(notes, "late input");
    const input = await json(["sessions", "upload", "--session", sessionId, "--file", notes]);
    expect(input.state).toBe("ready");
    const requestId = randomUUID();
    const submit = ["sessions", "submit", "--session", sessionId, "--request", requestId, "--message", "hello"];
    const deadline = new Date(Date.now() + 60_000).toISOString();
    const output = await cli([...submit, "--deadline", deadline, "--input", input.reference.inputId]);
    const accepted = withoutIntent(output);
    expect(accepted).toMatchObject({ requestId, state: "accepted" });
    // A retried submit with the same body replays the original request.
    const replay = await cli([...submit, "--deadline", deadline, "--input", input.reference.inputId]);
    expect(withoutIntent(replay).turnId).toBe(accepted.turnId);
    expect((await json(["sessions", "request", "--session", sessionId, "--request", requestId])).requestId).toBe(
      requestId,
    );
    const cancelId = randomUUID();
    const cancel = ["sessions", "cancel", "--session", sessionId, "--request", requestId, "--cancel-id", cancelId];
    expect((await json(cancel)).state).toBe("completed");
    expect(await json(["sessions", "collection", "--session", sessionId, "--request", requestId])).toMatchObject({
      completeness: "lost",
    });
    const history = await json(["sessions", "history", "--session", sessionId, "--all"]);
    expect(history.eventCursor).toStartWith(`${sessionId}:`);
    const events = (await cli(["sessions", "events", "--session", sessionId, "--count", "2"])).trim().split("\n");
    expect(events.map((line) => JSON.parse(line).sequence)).toEqual([1, 2]);
    expect((await json(["sessions", "resume", "--session", sessionId])).sessionId).toBe(sessionId);
    expect((await json(["sessions", "close", "--session", sessionId])).scope).toBe("session");
  } finally {
    listener.stop(true);
    await f.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
