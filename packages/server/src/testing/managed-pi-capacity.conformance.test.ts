// PC-140 concurrency: 1, 5 and 20 managed Pi sessions on real Docker within explicitly configured
// capacity. Run with POCKETCODER_MANAGED_PI_CONFORMANCE=1. Measurements print as one JSON line per run.
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedRuntimeConsumer } from "../../../../examples/clients/managed-runtime/consumer";
import { PI_FIXTURE_CONTENT } from "../../../../examples/harnesses/pi/fake-gateway";
import { waitFor } from "./e2e-test-support";
import { managedPiFixture } from "./managed-pi-fixture";
import { dockerCommand } from "./service-image-fixture";

const enabled = process.env.POCKETCODER_MANAGED_PI_CONFORMANCE === "1";
const bytes = (text: string) => {
  const [value, unit] = [Number.parseFloat(text), text.replace(/[\d.]/g, "")];
  const scale: Record<string, number> = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 };
  return value * (scale[unit] ?? 1);
};

// Samples CPU and memory of this controller's workspace containers until stopped.
function sampler(containers: () => Promise<string[]>) {
  const peak = { cpuPercent: 0, memoryMiB: 0, containers: 0 };
  let running = true;
  const loop = (async () => {
    while (running) {
      const ids = await containers().catch(() => []);
      if (ids.length) {
        const rows = (await dockerCommand("stats", "--no-stream", "--format", "{{json .}}", ...ids).catch(() => ""))
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { CPUPerc: string; MemUsage: string });
        const cpu = rows.reduce((sum, row) => sum + Number.parseFloat(row.CPUPerc), 0);
        const memory = rows.reduce((sum, row) => sum + bytes(row.MemUsage.split(" / ")[0] ?? "0B"), 0) / 1024 ** 2;
        peak.cpuPercent = Math.max(peak.cpuPercent, Math.round(cpu));
        peak.memoryMiB = Math.max(peak.memoryMiB, Math.round(memory));
        peak.containers = Math.max(peak.containers, ids.length);
      }
      await Bun.sleep(2000);
    }
  })();
  return async () => {
    running = false;
    await loop;
    return peak;
  };
}

test.skipIf(!enabled)(
  "1, 5 and 20 concurrent managed Pi sessions complete and clean up within configured capacity",
  async () => {
    const f = await managedPiFixture();
    const directory = await mkdtemp(join(tmpdir(), "pc-managed-pi-capacity-"));
    const results: Record<string, unknown>[] = [];
    try {
      const host = JSON.parse(await dockerCommand("info", "--format", "{{json .}}")) as {
        NCPU: number;
        MemTotal: number;
        ServerVersion: string;
      };
      for (const count of [1, 5, 20]) {
        const profile = await f.configure({ workspacesPerOwner: count, sessionsPerWorkspace: 1 });
        const consumer = new ManagedRuntimeConsumer(f.client, { canUse: () => true });
        const stop = sampler(() => f.containers());
        const started = Date.now();
        const sessions = await Promise.all(Array.from({ length: count }, () => consumer.startSession(profile, "user")));
        const turns = await Promise.all(
          sessions.map(async (session) => {
            const asked = await consumer.ask("user", session.sessionId, "Read the fixture file.");
            const done = await consumer.waitFor(
              "user",
              session.sessionId,
              asked.requestId,
              AbortSignal.timeout(600_000),
            );
            return { session, done, seconds: (Date.now() - started) / 1000 };
          }),
        );
        const elapsed = (Date.now() - started) / 1000;
        const active = [];
        for await (const workspace of f.admin.workspaces.all())
          if (!["canceled", "failed", "succeeded", "expired"].includes(workspace.state)) active.push(workspace);
        for (const turn of turns)
          expect(turn.done.request).toMatchObject({ outcome: "completed", finalResponse: PI_FIXTURE_CONTENT });
        expect(active.length).toBeLessThanOrEqual(count);
        // Close every session; the placement owner stops each session's own workspace.
        const closing = Date.now();
        await Promise.all(turns.map(({ session }) => consumer.close("user", session.sessionId)));
        await waitFor(async () => (await f.containers()).length === 0, 300_000, "workspace cleanup");
        const peak = await stop();
        const times = turns.map((turn) => turn.seconds).sort((a, b) => a - b);
        results.push({
          sessions: count,
          completed: turns.length,
          wallSeconds: Math.round(elapsed),
          firstTurnSeconds: Math.round(times[0] ?? 0),
          lastTurnSeconds: Math.round(times.at(-1) ?? 0),
          cleanupSeconds: Math.round((Date.now() - closing) / 1000),
          peakContainers: peak.containers,
          peakCpuPercent: peak.cpuPercent,
          peakMemoryMiB: peak.memoryMiB,
        });
      }
      console.log(
        JSON.stringify({
          docker: host.ServerVersion,
          cpus: host.NCPU,
          memoryGiB: Math.round(host.MemTotal / 1024 ** 3),
          pi: f.images.piVersion,
          image: f.images.imageId,
          results,
        }),
      );
    } catch (error) {
      console.error(
        f.logs
          .filter((line) => !line.includes("request."))
          .slice(-40)
          .join("\n"),
      );
      console.error(JSON.stringify(results));
      throw error;
    } finally {
      await f.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  3_600_000,
);
