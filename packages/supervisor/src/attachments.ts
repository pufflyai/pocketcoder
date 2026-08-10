import { createHash, type Hash } from "node:crypto";
import {
  type FileHandle,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type AgentFrame,
  type ATTACHMENT_FAILURE_CODES,
  type AttachmentChunk,
  type AttachmentDescriptor,
  AttachmentDescriptorSchema,
  type AttachmentStart,
} from "@pstdio/pocketcoder-contracts";

// Supervisor-owned attachment storage under $HOME/.pcd/attachments. Every
// upload writes a same-directory temporary payload, validates the declared
// length and digest, then atomically renames the payload and its sidecar so a
// completed file is the only observable outcome.

type SendFrame = (type: AgentFrame["type"], payload: unknown) => boolean;

const SIDECAR = ".metadata.json";
const TMP_PREFIX = /^\.(?:payload|metadata\.json)\.tmp-/;

type FailureCode = (typeof ATTACHMENT_FAILURE_CODES)[number];

export function defaultAttachmentRoot(): string {
  return join(process.env.HOME ?? homedir(), ".pcd", "attachments");
}

export function sanitizeAttachmentName(raw: string): string {
  const basename = raw.split(/[/\\]/).pop() ?? "";
  let name = "";
  for (const character of basename) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue;
    name += character;
  }
  name = name.replace(/^[\s.]+/, "").replace(/[\s.]+$/, "");
  if (name === "") return "attachment";
  return capUtf8Bytes(name, 255);
}

function capUtf8Bytes(name: string, max: number): string {
  if (Buffer.byteLength(name) <= max) return name;
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot) : "";
  const keepExtension = Buffer.byteLength(extension) < max;
  const budget = keepExtension ? max - Buffer.byteLength(extension) : max;
  let stem = dot > 0 ? name.slice(0, dot) : name;
  while (Buffer.byteLength(stem) > budget) stem = stem.slice(0, -1);
  if (stem === "") return "attachment";
  return keepExtension ? stem + extension : stem;
}

interface Sidecar {
  version: number;
  id: string;
  name: string;
  media_type: string;
  size_bytes: number;
  sha256: string;
  file: string;
}

interface ActiveUpload {
  attachmentId: string;
  name: string;
  mediaType: string;
  declared: number;
  received: number;
  nextSeq: number;
  directory: string;
  tmpPath: string;
  handle: FileHandle;
  hasher: Hash;
}

export class AttachmentManager {
  private readonly uploads = new Map<string, ActiveUpload>();
  // Frames for one operation can arrive while an earlier frame's filesystem
  // work is still in flight; the chain preserves WebSocket arrival order.
  private pipeline: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly send: SendFrame,
    private readonly root: () => string = defaultAttachmentRoot,
  ) {}

  handleStart(payload: AttachmentStart): Promise<void> {
    return this.enqueue(() => this.start(payload));
  }

  handleChunk(payload: AttachmentChunk): Promise<void> {
    return this.enqueue(() => this.chunk(payload));
  }

  handleFinish(payload: { operation_id: string }): Promise<void> {
    return this.enqueue(() => this.finish(payload.operation_id));
  }

  handleAbort(payload: { operation_id: string; reason: string }): Promise<void> {
    return this.enqueue(() => this.discard(payload.operation_id));
  }

  handleResolve(payload: { operation_id: string; attachment_ids: string[] }): Promise<void> {
    return this.enqueue(() => this.resolve(payload.operation_id, payload.attachment_ids));
  }

  async cleanupStartup(): Promise<void> {
    const entries = await readdir(this.root()).catch(() => [] as string[]);
    for (const entry of entries) {
      const directory = join(this.root(), entry);
      const files = await readdir(directory).catch(() => [] as string[]);
      for (const file of files) {
        if (TMP_PREFIX.test(file)) await rm(join(directory, file), { force: true });
      }
    }
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.pipeline.then(work, work);
    this.pipeline = next.catch(() => undefined);
    return next;
  }

  private async start(payload: AttachmentStart): Promise<void> {
    await this.discard(payload.operation_id);
    const name = sanitizeAttachmentName(payload.name);
    const directory = join(this.root(), payload.attachment_id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const tmpPath = join(directory, `.payload.tmp-${payload.operation_id}`);
    const handle = await open(tmpPath, "w", 0o600);
    this.uploads.set(payload.operation_id, {
      attachmentId: payload.attachment_id,
      name,
      mediaType: payload.media_type,
      declared: payload.size_bytes,
      received: 0,
      nextSeq: 0,
      directory,
      tmpPath,
      handle,
      hasher: createHash("sha256"),
    });
  }

  private async chunk(payload: AttachmentChunk): Promise<void> {
    const upload = this.uploads.get(payload.operation_id);
    if (!upload) {
      this.fail(payload.operation_id, "invalid", "unknown upload operation");
      return;
    }
    if (payload.seq !== upload.nextSeq) {
      await this.failAndDiscard(payload.operation_id, "sequence", "chunk out of order");
      return;
    }
    const bytes = Buffer.from(payload.content_b64, "base64");
    if (upload.received + bytes.byteLength > upload.declared) {
      await this.failAndDiscard(
        payload.operation_id,
        "too_large",
        "bytes exceed the declared length",
      );
      return;
    }
    await upload.handle.write(bytes);
    upload.hasher.update(bytes);
    upload.received += bytes.byteLength;
    upload.nextSeq += 1;
    this.send("attachment_ack", {
      operation_id: payload.operation_id,
      seq: payload.seq,
      received_bytes: upload.received,
    });
  }

  private async finish(operationId: string): Promise<void> {
    const upload = this.uploads.get(operationId);
    if (!upload) {
      this.fail(operationId, "invalid", "unknown upload operation");
      return;
    }
    if (upload.received !== upload.declared) {
      await this.failAndDiscard(operationId, "invalid", "received bytes mismatch");
      return;
    }
    await upload.handle.close();
    this.uploads.delete(operationId);
    const descriptor: AttachmentDescriptor = {
      id: upload.attachmentId,
      name: upload.name,
      path: join(upload.directory, upload.name),
      media_type: upload.mediaType,
      size_bytes: upload.received,
      sha256: upload.hasher.digest("hex"),
    };
    const existing = await this.readSidecar(upload.attachmentId);
    if (existing) {
      await rm(upload.tmpPath, { force: true });
      const identical =
        existing.sha256 === descriptor.sha256 &&
        existing.size_bytes === descriptor.size_bytes &&
        existing.name === descriptor.name &&
        existing.media_type === descriptor.media_type;
      this.send("attachment_result", {
        operation_id: operationId,
        status: identical ? "existing" : "conflict",
        descriptor: identical ? this.descriptorOf(upload.attachmentId, existing) : descriptor,
      });
      return;
    }
    await rename(upload.tmpPath, descriptor.path);
    const sidecar: Sidecar = {
      version: 1,
      id: descriptor.id,
      name: descriptor.name,
      media_type: descriptor.media_type,
      size_bytes: descriptor.size_bytes,
      sha256: descriptor.sha256,
      file: descriptor.name,
    };
    const sidecarTmp = join(upload.directory, `.metadata.json.tmp-${operationId}`);
    const handle = await open(sidecarTmp, "w", 0o600);
    await handle.writeFile(JSON.stringify(sidecar));
    await handle.close();
    await rename(sidecarTmp, join(upload.directory, SIDECAR));
    this.send("attachment_result", { operation_id: operationId, status: "created", descriptor });
  }

  private async resolve(operationId: string, attachmentIds: string[]): Promise<void> {
    const descriptors: AttachmentDescriptor[] = [];
    for (const id of attachmentIds) {
      const sidecar = await this.readSidecar(id);
      const descriptor = sidecar && (await this.validated(id, sidecar));
      if (!descriptor) {
        this.send("attachment_resolved", { operation_id: operationId, missing_id: id });
        return;
      }
      descriptors.push(descriptor);
    }
    this.send("attachment_resolved", { operation_id: operationId, descriptors });
  }

  private async readSidecar(attachmentId: string): Promise<Sidecar | null> {
    try {
      const raw = await readFile(join(this.root(), attachmentId, SIDECAR), "utf8");
      return JSON.parse(raw) as Sidecar;
    } catch {
      return null;
    }
  }

  private async validated(
    attachmentId: string,
    sidecar: Sidecar,
  ): Promise<AttachmentDescriptor | null> {
    if (sidecar.version !== 1 || sidecar.id !== attachmentId) return null;
    if (sidecar.file !== sidecar.name || sidecar.name !== sanitizeAttachmentName(sidecar.name)) {
      return null;
    }
    const descriptor = this.descriptorOf(attachmentId, sidecar);
    if (!AttachmentDescriptorSchema.safeParse(descriptor).success) return null;
    const info = await stat(descriptor.path).catch(() => null);
    if (!info?.isFile() || info.size !== sidecar.size_bytes) return null;
    return descriptor;
  }

  private descriptorOf(attachmentId: string, sidecar: Sidecar): AttachmentDescriptor {
    return {
      id: attachmentId,
      name: sidecar.name,
      path: join(this.root(), attachmentId, sidecar.file),
      media_type: sidecar.media_type,
      size_bytes: sidecar.size_bytes,
      sha256: sidecar.sha256,
    };
  }

  private async discard(operationId: string): Promise<void> {
    const upload = this.uploads.get(operationId);
    if (!upload) return;
    this.uploads.delete(operationId);
    await upload.handle.close().catch(() => {});
    await rm(upload.tmpPath, { force: true });
  }

  private fail(operationId: string, code: FailureCode, detail: string): void {
    this.send("attachment_result", {
      operation_id: operationId,
      status: "failed",
      failure_code: code,
      detail,
    });
  }

  private async failAndDiscard(
    operationId: string,
    code: FailureCode,
    detail: string,
  ): Promise<void> {
    await this.discard(operationId);
    this.fail(operationId, code, detail);
  }
}
