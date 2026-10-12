import { randomUUID } from "node:crypto";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitoringConfig, monitoringImages } from "../../deploy/monitoring/config";
import type { Thresholds } from "../../deploy/monitoring/rules";
import { command, freePort, waitFor } from "./local-process";
import { faultLabels, matchingNotification, type Notification } from "./monitoring-notification";

export async function monitoringFixture(input: { token: string; target: string; thresholds: Partial<Thresholds> }) {
  const directory = await mkdtemp(join(tmpdir(), "pc53-monitoring-"));
  const id = `pc53-${randomUUID()}`;
  const prometheus = `${id}-prometheus`;
  const alertmanager = `${id}-alertmanager`;
  const promPort = freePort();
  const alertPort = freePort();
  const received: Notification[] = [];
  const cursors = new Map<string, number>();
  const episodes = new Map<string, Record<string, string>>();
  const receiver = Bun.serve({
    hostname: "0.0.0.0",
    port: 0,
    async fetch(request) {
      received.push((await request.json()) as Notification);
      return new Response("ok");
    },
  });
  const config = monitoringConfig({
    managerTarget: input.target,
    credentialsFile: "/etc/pocketcoder/token",
    alertmanagerTarget: `${alertmanager}:9093`,
    receiverUrl: `http://host.docker.internal:${receiver.port}`,
    operator: "au-re",
    runbookUrl: "https://github.com/pufflyai/pocketcoder/blob/feature/pc-53-managed-monitoring/docs/monitoring.md",
    interval: "1s",
    hold: "0s",
    thresholds: input.thresholds,
  });
  async function docker(args: string[]) {
    return command(["docker", ...args], { quiet: true });
  }
  async function close() {
    await Promise.all([prometheus, alertmanager].map((name) => docker(["rm", "-f", name]).catch(() => {})));
    await docker(["network", "rm", id]).catch(() => {});
    await receiver.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
  try {
    for (const [name, value] of Object.entries(config))
      await writeFile(join(directory, `${name}.json`), JSON.stringify(value));
    await writeFile(join(directory, "token"), input.token, { mode: 0o600 });
    for (const [image, entrypoint, args] of [
      [monitoringImages.prometheus, "/bin/promtool", ["check", "config", "/etc/pocketcoder/prometheus.json"]],
      [monitoringImages.alertmanager, "/bin/amtool", ["check-config", "/etc/pocketcoder/alertmanager.json"]],
    ] as const)
      await docker([
        "run",
        "--rm",
        "--user",
        "0",
        "-v",
        `${directory}:/etc/pocketcoder:ro`,
        "--entrypoint",
        entrypoint,
        image,
        ...args,
      ]);
    await docker(["network", "create", id]);
    for (const [name, image, port, containerPort, args] of [
      [
        alertmanager,
        monitoringImages.alertmanager,
        alertPort,
        9093,
        ["--config.file=/etc/pocketcoder/alertmanager.json", "--cluster.listen-address="],
      ],
      [
        prometheus,
        monitoringImages.prometheus,
        promPort,
        9090,
        [
          "--config.file=/etc/pocketcoder/prometheus.json",
          "--storage.tsdb.retention.time=1h",
          "--web.enable-lifecycle",
        ],
      ],
    ] as const)
      await docker([
        "run",
        "-d",
        "--name",
        name,
        "--network",
        id,
        "--add-host",
        "host.docker.internal:host-gateway",
        "--user",
        "0",
        "-p",
        `127.0.0.1:${port}:${containerPort}`,
        "-v",
        `${directory}:/etc/pocketcoder:ro`,
        image,
        ...args,
      ]);
    const url = `http://127.0.0.1:${promPort}`;
    await waitFor(
      () =>
        fetch(`${url}/-/ready`)
          .then((r) => r.ok)
          .catch(() => false),
      30_000,
      "real Prometheus startup",
    );
    async function alerts() {
      const response = await fetch(`${url}/api/v1/alerts`);
      const body = (await response.json()) as { data: { alerts: { state: string; labels: Record<string, string> }[] } };
      return body.data.alerts;
    }
    async function notification(family: string, status: string, expected: Record<string, string>[]) {
      let matched!: NonNullable<ReturnType<typeof matchingNotification>>;
      await waitFor(
        async () => {
          const found = matchingNotification(received, cursors.get(family) ?? 0, status, expected);
          if (!found) return false;
          matched = found;
          return true;
        },
        30_000,
        `${family} ${status} operator webhook`,
      );
      cursors.set(family, matched.index + 1);
      return matched.labels;
    }
    return {
      startFault(family: string) {
        cursors.set(family, received.length);
        episodes.delete(family);
      },
      async rotateToken(token: string) {
        await writeFile(join(directory, "token.next"), token, { mode: 0o600 });
        await rename(join(directory, "token.next"), join(directory, "token"));
      },
      async firing(family: string, timeoutMs = 30_000, scope: Record<string, string | undefined> = {}) {
        let expected: Record<string, string>[] = [];
        await waitFor(
          async () => {
            expected = faultLabels(
              (await alerts())
                .filter((alert) => alert.labels.family === family && alert.state === "firing")
                .map((alert) => alert.labels),
              scope,
            );
            return expected.length > 0;
          },
          timeoutMs,
          `${family} alert firing`,
        );
        episodes.set(family, await notification(family, "firing", expected));
        console.log(JSON.stringify({ alertFired: family, operator: "au-re", delivery: "owned localhost webhook" }));
      },
      async resolved(family: string) {
        const labels = episodes.get(family);
        if (!labels) throw new Error(`No delivered firing alert for ${family}`);
        await waitFor(
          async () => !(await alerts()).some((alert) => alert.labels.family === family && alert.state === "firing"),
          30_000,
          `${family} alert cleared`,
        );
        await notification(family, "resolved", [labels]);
        console.log(JSON.stringify({ alertResolved: family, operator: "au-re" }));
      },
      async query(expression: string) {
        const body = (await (await fetch(`${url}/api/v1/query?query=${encodeURIComponent(expression)}`)).json()) as {
          data: { result: { value: [number, string] }[] };
        };
        return Number(body.data.result[0]?.value[1]);
      },
      async diagnostics() {
        return {
          received,
          prometheus: await alerts(),
          alertmanager: await (await fetch(`http://127.0.0.1:${alertPort}/api/v2/alerts`)).json(),
        };
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
