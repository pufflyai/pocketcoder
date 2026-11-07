import { randomUUID } from "node:crypto";
import { type ExecSpec, type ServiceReceipt, ServiceStartSchema } from "@pstdio/pocketcoder-contracts";
import type { SupervisorLogs } from "../observability/supervisor-logs";
import { groupHasWriters } from "./process-group";

type Command = NonNullable<ExecSpec["workload"]>["infrastructure"][string];
type Attempt = {
  exited: boolean;
  receipt: ServiceReceipt;
  child?: Bun.Subprocess<"ignore", "pipe", "pipe">;
  drains: Promise<void>[];
};
type Identity = { workspaceId: string; incarnationId: string };

export class WorkspaceServices {
  private readonly attempts = new Map<string, Attempt>();
  private readonly starts = new Map<string, ServiceReceipt>();
  private readonly pending = new Map<string, Promise<unknown>>();
  private server?: ReturnType<typeof Bun.serve>;
  private closed = false;
  private closing?: Promise<void>;
  constructor(
    private readonly declared: Record<string, Command>,
    private readonly environment: (env: Record<string, string>) => Record<string, string>,
    private readonly logs: Pick<SupervisorLogs, "pump">,
    private readonly identity: Identity,
    private readonly health: Record<string, { baseUrl: string; healthPath: string }> = {},
  ) {}

  listen(socket: string) {
    this.server = Bun.serve({ unix: socket, fetch: (request) => this.handle(request) });
  }

  private async handle(request: Request) {
    const [, name, action] = new URL(request.url).pathname.split("/");
    if (request.method !== "POST" || !name || !Object.hasOwn(this.declared, name))
      return new Response(null, { status: 404 });
    if (!["start", "stop", "status"].includes(action ?? "")) return new Response(null, { status: 400 });
    let startId = "";
    if (action === "start") {
      const parsed = ServiceStartSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return new Response(null, { status: 400 });
      startId = parsed.data.startId;
    }
    const previous = this.pending.get(name) ?? Promise.resolve();
    const task = previous.then(async () => {
      if (this.closed) return new Response(null, { status: 409 });
      try {
        if (action === "start") return Response.json(await this.start(name, startId));
        if (action === "stop") await this.stop(name);
        return Response.json(await this.status(name));
      } catch {
        return new Response(null, { status: 409 });
      }
    });
    this.pending.set(
      name,
      task.catch(() => {}),
    );
    return task;
  }

  async start(name: string, startId: string = randomUUID()) {
    if (this.closed || !Object.hasOwn(this.declared, name)) throw new Error("Workspace service is unavailable");
    const replay = this.starts.get(startId);
    if (replay) {
      if (replay.name !== name) throw new Error("Service start identity conflicts");
      return replay;
    }
    const current = this.attempts.get(name);
    if (current?.receipt.state === "lost") throw new Error("Service outcome must be reconciled before restart");
    if (current?.child) {
      if (!current.exited || groupHasWriters(current.child.pid))
        throw new Error("The previous service group has not stopped");
      await Promise.all(current.drains);
    }
    const receipt: ServiceReceipt = {
      ...this.identity,
      name,
      startId,
      attemptId: randomUUID(),
      state: "starting",
      pid: null,
      exitCode: null,
      listener: "unknown",
    };
    // Intent exists before spawn. A controller reconnect reuses this process owner.
    const attempt: Attempt = { receipt, drains: [], exited: false };
    this.attempts.set(name, attempt);
    const command = this.declared[name];
    if (!command) throw new Error("Undeclared workspace service");
    try {
      attempt.child = Bun.spawn(command.command, {
        cwd: command.cwd ?? "/",
        env: this.environment(command.env),
        detached: true,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch {
      receipt.state = "lost";
      this.starts.set(startId, { ...receipt });
      throw new Error("Service spawn failed");
    }
    void attempt.child.exited.then((code) => {
      attempt.exited = true;
      receipt.exitCode = code;
    });
    receipt.state = "running";
    receipt.pid = attempt.child.pid;
    attempt.drains = [this.logs.pump(attempt.child.stdout, "stdout"), this.logs.pump(attempt.child.stderr, "stderr")];
    const accepted = { ...receipt };
    this.starts.set(startId, accepted);
    return accepted;
  }

  async status(name: string): Promise<ServiceReceipt> {
    const attempt = this.attempts.get(name);
    if (!attempt)
      return {
        ...this.identity,
        name,
        startId: null,
        attemptId: null,
        state: "stopped",
        pid: null,
        exitCode: null,
        listener: "unknown",
      };
    const { child, receipt } = attempt;
    if (child && attempt.exited && receipt.state !== "stopped") {
      receipt.state = groupHasWriters(child.pid) ? "lost" : "exited";
    }
    const target = this.health[name];
    let listener: ServiceReceipt["listener"] = "unknown";
    if (target) {
      listener = await fetch(new URL(target.healthPath, target.baseUrl), {
        signal: AbortSignal.timeout(250),
        redirect: "error",
      }).then(
        async (response) => {
          await response.body?.cancel();
          return response.ok ? ("healthy" as const) : ("unhealthy" as const);
        },
        () => "unhealthy" as const,
      );
    }
    return { ...receipt, listener };
  }

  signal(signal: "SIGTERM" | "SIGKILL") {
    for (const { child } of this.attempts.values()) if (child) signalGroup(child.pid, signal);
  }

  private async stop(name: string) {
    const attempt = this.attempts.get(name);
    if (!attempt?.child) return;
    signalGroup(attempt.child.pid, "SIGKILL");
    attempt.receipt.exitCode = await attempt.child.exited;
    attempt.exited = true;
    while (groupHasWriters(attempt.child.pid)) await Bun.sleep(10);
    await Promise.all(attempt.drains);
    attempt.receipt.state = "stopped";
  }

  close() {
    this.closing ??= (async () => {
      this.closed = true;
      this.server?.stop(true);
      await Promise.all(this.pending.values());
      await Promise.all([...this.attempts.keys()].map((name) => this.stop(name)));
    })();
    return this.closing;
  }
}

function signalGroup(pid: number, signal: "SIGTERM" | "SIGKILL") {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    // EPERM during macOS exit is not stop proof. The caller still waits for writers.
    if (!["ESRCH", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
}
