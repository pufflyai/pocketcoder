import { describe, expect, test } from "bun:test";
import type { WorkspaceSummary } from "./control-plane";
import { LiveSession, type LiveStatusPoller } from "./live-session";
import { relayTarget, TargetRef } from "./session-target";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";

function context(statuses: Array<string | undefined>) {
  return {
    ui: {
      setStatus: (_key: string, text: string | undefined) => statuses.push(text),
      notify: () => {},
    },
  };
}

function workspace(id: string, changeCursor: number) {
  return { id, change_cursor: changeCursor } as WorkspaceSummary;
}

interface PollerRecord {
  workspaceId: string;
  cursor: number;
  events: string[];
}

function harness() {
  const events: string[] = [];
  const pollers: PollerRecord[] = [];
  const statuses: Array<string | undefined> = [];
  const targets = new TargetRef(relayTarget("http://pocketcoder.test", "key", A));
  const createPoller = (resource: Pick<WorkspaceSummary, "id" | "change_cursor">) => {
    const record = {
      workspaceId: resource.id,
      cursor: resource.change_cursor,
      events: [] as string[],
    };
    pollers.push(record);
    const note = (event: string) => {
      record.events.push(event);
      events.push(`${resource.id}:${event}`);
    };
    return {
      start: () => note("start"),
      pause: () => note("pause"),
      resume: () => note("resume"),
      stop: async () => note("stop"),
    } satisfies LiveStatusPoller;
  };
  const sessions = new LiveSession(targets, createPoller);
  return { events, pollers, sessions, statuses, targets };
}

describe("TargetRef", () => {
  test("compare-and-swap rejects a target replaced by the user", () => {
    const source = relayTarget("http://pocketcoder.test", "key", A);
    const targets = new TargetRef(source);
    const observed: string[] = [];
    const dispose = targets.onChange((target) => {
      if (target.mode === "relay") observed.push(target.workspaceId);
    });

    targets.set(relayTarget("http://pocketcoder.test", "key", C));
    expect(targets.compareAndSwap(source, relayTarget("http://pocketcoder.test", "key", B))).toBe(
      false,
    );
    dispose();
    targets.set(relayTarget("http://pocketcoder.test", "key", B));
    expect(observed).toEqual([C]);
  });
});

describe("LiveSession", () => {
  test("retargets an open session and creates a paused B poller from B's cursor", async () => {
    const { events, pollers, sessions, statuses, targets } = harness();
    const source = targets.current;
    const identity = await sessions.activate(context(statuses));
    sessions.attachPoller(identity, workspace(A, 4));
    sessions.pause();

    expect(await sessions.applyResolved(identity, source, workspace(B, 19))).toBe(true);

    expect(targets.current).toEqual(relayTarget("http://pocketcoder.test", "key", B));
    expect(pollers).toMatchObject([
      { workspaceId: A, cursor: 4, events: ["start", "pause", "stop"] },
      { workspaceId: B, cursor: 19, events: ["pause", "start"] },
    ]);
    expect(events.indexOf(`${A}:stop`)).toBeLessThan(events.indexOf(`${B}:start`));
    expect(statuses.at(-1)).toBe(`ws ${B.slice(0, 8)}`);

    sessions.resume();
    expect(pollers[1]?.events.at(-1)).toBe("resume");
  });

  test("ignores a late result after session shutdown", async () => {
    const { pollers, sessions, statuses, targets } = harness();
    const source = targets.current;
    const identity = await sessions.activate(context(statuses));
    sessions.attachPoller(identity, workspace(A, 1));
    await sessions.shutdown();

    expect(await sessions.applyResolved(identity, source, workspace(B, 2))).toBe(false);
    expect(targets.current).toBe(source);
    expect(pollers).toHaveLength(1);
  });

  test("lets an explicit workspace switch win over a late resolution", async () => {
    const { pollers, sessions, statuses, targets } = harness();
    const source = targets.current;
    const identity = await sessions.activate(context(statuses));
    sessions.attachPoller(identity, workspace(A, 1));
    targets.set(relayTarget("http://pocketcoder.test", "key", C));

    expect(await sessions.applyResolved(identity, source, workspace(B, 2))).toBe(false);
    expect(targets.current).toEqual(relayTarget("http://pocketcoder.test", "key", C));
    expect(pollers[0]?.events).not.toContain("stop");
  });

  test("does not rebuild state when the resolved workspace is unchanged", async () => {
    const { pollers, sessions, statuses, targets } = harness();
    const source = targets.current;
    const identity = await sessions.activate(context(statuses));
    sessions.attachPoller(identity, workspace(A, 1));

    expect(await sessions.applyResolved(identity, source, workspace(A, 2))).toBe(false);
    expect(pollers).toHaveLength(1);
    expect(pollers[0]?.events).toEqual(["start"]);
  });
});
