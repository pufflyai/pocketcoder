import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { AgentFrame, ServerFrame, WorkspaceCredential } from "@pstdio/pocketcoder-contracts";
import { openLeaseDirectory } from "./lease-directory";

type CredentialMessage =
  | Pick<Extract<AgentFrame, { type: "credential_renew" }>, "type" | "payload">
  | Pick<Extract<AgentFrame, { type: "credential_installed" }>, "type" | "payload">;
type Renewed = Extract<ServerFrame, { type: "credential_renewed" }>["payload"];
type Confirmation = Extract<AgentFrame, { type: "credential_installed" }>["payload"];
type Installed = { value: WorkspaceCredential; renewAt: number; requestId: string | null; retryAt: number };

export class WorkspaceCredentials {
  private readonly files = new Map<string, Installed>();
  private readonly directories = new Map<string, ReturnType<typeof openLeaseDirectory>>();
  private readonly confirmations = new Map<string, Confirmation>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending = Promise.resolve();
  private stopped = false;
  private quiescing = false;
  private setupMemoryExpiry: number | null = null;

  constructor(
    private readonly callbacks: {
      send(message: CredentialMessage): boolean;
      expired(): void;
      addSecret(credential: string): void;
    },
  ) {}

  get setupExpiresAt() {
    const expiry = [...this.files.values()]
      .filter(({ value }) => value.purpose === "setup-issuer")
      .map(({ value }) => Date.parse(value.expires_at));
    return expiry.length ? new Date(Math.min(...expiry)).toISOString() : null;
  }

  install(values: WorkspaceCredential[]) {
    return this.serialize(async () => {
      for (const value of values) {
        const previous = this.files.get(value.path)?.value;
        await this.write(value);
        if (previous && previous.purpose === "runtime-issuer" && previous.lease_id !== value.lease_id) {
          this.confirmations.set(previous.lease_id, { previous_lease_id: previous.lease_id, lease_id: value.lease_id });
        }
      }
      this.schedule();
    });
  }

  renewed(payload: Renewed) {
    return this.serialize(async () => {
      const previous = [...this.files.values()].find(({ value }) => value.lease_id === payload.previous_lease_id);
      if (!previous || previous.requestId !== payload.request_id || previous.value.path !== payload.credential.path)
        return;
      await this.write(payload.credential);
      const confirmation = { previous_lease_id: payload.previous_lease_id, lease_id: payload.credential.lease_id };
      this.confirmations.set(payload.previous_lease_id, confirmation);
      this.callbacks.send({ type: "credential_installed", payload: confirmation });
      this.schedule();
    });
  }

  confirmed(payload: Confirmation) {
    if (this.confirmations.get(payload.previous_lease_id)?.lease_id === payload.lease_id) {
      this.confirmations.delete(payload.previous_lease_id);
    }
  }

  setQuiescing(value: boolean) {
    this.quiescing = value;
    this.schedule();
  }

  watchSetupExpiry(expiresAt: string) {
    this.setupMemoryExpiry = Date.parse(expiresAt);
    this.schedule();
  }

  completeSetup() {
    return this.serialize(async () => {
      this.setupMemoryExpiry = null;
      for (const [path, { value }] of this.files) {
        if (value.purpose !== "setup-issuer") continue;
        this.directories.get(dirname(path))?.remove(basename(path));
        this.files.delete(path);
      }
      this.schedule();
    });
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.pending;
    for (const path of this.files.keys()) this.directories.get(dirname(path))?.remove(basename(path));
    for (const directory of this.directories.values()) directory.close();
    this.directories.clear();
    this.files.clear();
    this.confirmations.clear();
  }

  private serialize(work: () => Promise<void>) {
    const next = this.pending.then(async () => {
      if (!this.stopped) await work();
    });
    this.pending = next.catch(() => {});
    return next;
  }

  private async write(value: WorkspaceCredential) {
    const now = Date.now();
    const expiresAt = Date.parse(value.expires_at);
    const bytes = [...this.files.values()]
      .filter((row) => row.value.path !== value.path)
      .reduce((total, row) => total + Buffer.byteLength(row.value.credential), Buffer.byteLength(value.credential));
    if (expiresAt <= now || bytes > 524_288) throw new Error("Workspace credential cannot be installed.");
    this.callbacks.addSecret(value.credential);
    const parent = dirname(value.path);
    let directory = this.directories.get(parent);
    if (!directory) {
      await mkdir(parent, { recursive: true, mode: 0o700 });
      directory = openLeaseDirectory(parent);
      this.directories.set(parent, directory);
    }
    directory.write(basename(value.path), value.credential);
    this.files.set(value.path, { value, renewAt: now + (expiresAt - now) / 2, requestId: null, retryAt: now });
  }

  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    if (this.stopped || (!this.files.size && this.setupMemoryExpiry === null)) return;
    const now = Date.now();
    let next = now + 1000;
    if (this.setupMemoryExpiry !== null) {
      if (this.setupMemoryExpiry <= now) {
        this.callbacks.expired();
        return;
      }
      next = Math.min(next, this.setupMemoryExpiry);
    }
    for (const row of this.files.values()) {
      const expiry = Date.parse(row.value.expires_at);
      if (expiry <= now) {
        this.callbacks.expired();
        return;
      }
      next = Math.min(next, expiry);
      if (row.value.purpose === "setup-issuer" || this.quiescing) continue;
      if (now >= row.renewAt && now >= row.retryAt) {
        row.requestId ??= randomUUID();
        this.callbacks.send({
          type: "credential_renew",
          payload: { lease_id: row.value.lease_id, request_id: row.requestId },
        });
        row.retryAt = now + 1000;
      }
      next = Math.min(next, row.requestId ? row.retryAt : row.renewAt);
    }
    for (const confirmation of this.confirmations.values()) {
      this.callbacks.send({ type: "credential_installed", payload: confirmation });
    }
    this.timer = setTimeout(() => this.schedule(), Math.max(1, next - now));
  }
}
