import { z } from "zod";
import {
  AttachmentAbortPayload,
  AttachmentAckPayload,
  AttachmentChunkPayload,
  AttachmentFinishPayload,
  AttachmentResolvedPayload,
  AttachmentResolvePayload,
  AttachmentResultPayload,
  AttachmentStartPayload,
} from "../attachments/attachment";
import { ConversationMessageInputSchema } from "../conversations/conversation";
import { ScreenshotCapturePayload } from "../displays/screenshot";
import { CONVERSATION_RESTORE_CAPABILITIES } from "../persistence/persistence";
import { PreviewSocketPayload } from "../previews/preview";
import { ExecSpecSchema } from "./protocol-exec";

export {
  type ExecSpec,
  ExecSpecSchema,
  type RestoreMode,
  RestoreModeSchema,
  SOURCE_CREDENTIAL_MAX_BYTES,
} from "./protocol-exec";

import {
  TerminalClosedPayload,
  TerminalClosePayload,
  TerminalInputPayload,
  TerminalOpenedPayload,
  TerminalOpenPayload,
  TerminalOutputPayload,
  TerminalResizePayload,
} from "../terminals/terminal";
import {
  CheckpointInstalledPayload,
  CheckpointPreparedPayload,
  CheckpointUploadPayload,
  CheckpointUploadStatusPayload,
  PrepareCheckpointArchivePayload,
} from "./protocol-checkpoint";

export * from "./protocol-checkpoint";
export * from "./protocol-credentials";

import {
  CredentialInstalledPayload,
  CredentialRenewedPayload,
  CredentialRenewPayload,
  WorkspaceCredentialSchema,
} from "./protocol-credentials";

import {
  ProxyStreamAckPayload,
  ProxyStreamCancelPayload,
  ProxyStreamChunkPayload,
  ProxyStreamEndPayload,
  ProxyStreamStartPayload,
} from "./protocol-stream";

export {
  PROXY_STREAM_CHUNK_BYTES,
  STREAMING_MIN_PROTOCOL_VERSION,
} from "./protocol-stream";
export {
  LeaseAssignmentFrameSchema,
  POOL_PROTOCOL_VERSION,
  type PoolProviderInput,
  PoolProviderInputSchema,
  PoolRegisteredFrameSchema,
  type ProviderBootstrapInput,
  ProviderBootstrapInputSchema,
  type ProviderInput,
  ProviderInputSchema,
} from "./provider-protocol";

// The pocketcoder-supervisor protocol: JSON text frames over one
// outbound WSS connection per workspace. There is no worker lease, caller-
// supplied command execution, tunnel, or general file API. Interactive PTYs
// exist only for the template-declared command and use scope-gated v4 frames.

export const LEGACY_PROTOCOL_VERSION = 1;
export const PROTOCOL_VERSION = 11;
export const RUNTIME_CREDENTIAL_MIN_PROTOCOL_VERSION = 9;
export const ATTACHMENTS_MIN_PROTOCOL_VERSION = 3;
export const SOURCE_CREDENTIAL_MIN_PROTOCOL_VERSION = 8;
export const SUPPORTED_PROTOCOL_VERSIONS = [
  LEGACY_PROTOCOL_VERSION,
  2,
  3,
  4,
  5,
  6,
  7,
  8,
  9,
  10,
  PROTOCOL_VERSION,
] as const;
export type ProtocolVersion = (typeof SUPPORTED_PROTOCOL_VERSIONS)[number];

export const MAX_FRAME_BYTES = 1_048_576;

// Registration headers on the upgrade request.
export const HEADER_PROTOCOL = "x-pocketcoder-protocol";
export const HEADER_WORKSPACE = "x-pocketcoder-workspace";
export const HEADER_REGISTRATION = "x-pocketcoder-registration";
export const HEADER_RECONNECT = "x-pocketcoder-reconnect";
export const HEADER_POOL_RUNTIME = "x-pocketcoder-pool-runtime";
export const HEADER_POOL_ENROLLMENT = "x-pocketcoder-pool-enrollment";

const EnvelopeBase = z.object({
  v: z.union([
    z.literal(LEGACY_PROTOCOL_VERSION),
    z.literal(2),
    z.literal(3),
    z.literal(4),
    z.literal(5),
    z.literal(6),
    z.literal(7),
    z.literal(8),
    z.literal(9),
    z.literal(10),
    z.literal(PROTOCOL_VERSION),
  ]),
  workspace_id: z.uuid(),
  connection_id: z.uuid(),
  seq: z.number().int().nonnegative(),
  sent_at: z.iso.datetime(),
});

// --- Agent -> Server frames ---

export const RegisteredPayload = z.object({
  agent_version: z.string(),
  template: z.object({
    name: z.string(),
    version: z.string(),
    digest: z.string(),
  }),
  agentapi_version: z.string().optional(),
  services: z.array(z.string()),
  pid: z.number().int().positive(),
});

export const HeartbeatPayload = z.object({
  child: z.enum(["starting", "setup", "running", "exited", "terminating"]),
  agentapi_state: z.enum(["unknown", "stable", "running"]).optional(),
});

export const ProcessStatePayload = z.object({
  phase: z.enum(["starting", "setup", "running", "exited", "terminating"]),
  exit_code: z.number().int().nullable().optional(),
  setup_step: z.string().optional(),
  detail: z.string().max(512).optional(),
});

export const ServiceHealthPayload = z.object({
  service: z.string(),
  health: z.enum(["unknown", "starting", "healthy", "unhealthy"]),
  detail: z.string().max(512).optional(),
});

export const AgentStatePayload = z.object({
  state: z.enum(["running", "stable"]),
});

export const NetworkStatePayload = z.object({
  state: z.enum(["starting", "ready", "degraded"]),
  detail: z.string().max(512).optional(),
});

export const LogChunkPayload = z.object({
  stream: z.enum(["stdout", "stderr", "runtime"]),
  content_b64: z.string().max(87_400), // ~64 KiB decoded
  occurred_at: z.iso.datetime(),
});

export const ProxyResponsePayload = z.object({
  request_id: z.uuid(),
  status: z.number().int().min(100).max(599).optional(),
  headers: z.record(z.string(), z.string()).default({}),
  body_b64: z.string().optional(),
  error_code: z.enum(["unreachable", "deadline", "too_large"]).optional(),
});

export const TerminationAckPayload = z.object({
  phase: z.enum(["term_sent", "killed", "exited"]),
});

export const SourceResolvedPayload = z.object({
  repository: z.string().min(1).max(64),
  requested_revision: z.string().min(1).max(256),
  resolved_commit: z.string().regex(/^[0-9a-f]{40,64}$/),
});

export const CheckpointStatusPayload = z.object({
  operation_id: z.uuid(),
  phase: z.enum(["quiescing", "quiesced", "failed"]),
  detail: z.string().max(512).optional(),
});

export const OutputPublishedPayload = z.object({
  name: z.string().min(1).max(64),
  value: z.unknown(),
});

export const RestoreStatusPayload = z.object({
  phase: z.enum(["validating", "ready", "failed"]),
  capability: z.enum(CONVERSATION_RESTORE_CAPABILITIES),
  detail: z.string().max(512).optional(),
});

export const ConversationMessagePayload = ConversationMessageInputSchema;

export const AgentFrameSchema = z.discriminatedUnion("type", [
  EnvelopeBase.extend({ type: z.literal("preview_socket"), payload: PreviewSocketPayload }),
  EnvelopeBase.extend({ type: z.literal("credential_renew"), payload: CredentialRenewPayload }),
  EnvelopeBase.extend({ type: z.literal("credential_installed"), payload: CredentialInstalledPayload }),
  EnvelopeBase.extend({ type: z.literal("setup_complete"), payload: z.object({ request_id: z.uuid() }) }),
  EnvelopeBase.extend({ type: z.literal("registered"), payload: RegisteredPayload }),
  EnvelopeBase.extend({ type: z.literal("heartbeat"), payload: HeartbeatPayload }),
  EnvelopeBase.extend({ type: z.literal("process_state"), payload: ProcessStatePayload }),
  EnvelopeBase.extend({ type: z.literal("service_health"), payload: ServiceHealthPayload }),
  EnvelopeBase.extend({ type: z.literal("agent_state"), payload: AgentStatePayload }),
  EnvelopeBase.extend({ type: z.literal("network_state"), payload: NetworkStatePayload }),
  EnvelopeBase.extend({ type: z.literal("log_chunk"), payload: LogChunkPayload }),
  EnvelopeBase.extend({ type: z.literal("proxy_response"), payload: ProxyResponsePayload }),
  EnvelopeBase.extend({ type: z.literal("proxy_stream_start"), payload: ProxyStreamStartPayload }),
  EnvelopeBase.extend({ type: z.literal("proxy_stream_chunk"), payload: ProxyStreamChunkPayload }),
  EnvelopeBase.extend({ type: z.literal("proxy_stream_end"), payload: ProxyStreamEndPayload }),
  EnvelopeBase.extend({ type: z.literal("terminal_opened"), payload: TerminalOpenedPayload }),
  EnvelopeBase.extend({ type: z.literal("terminal_output"), payload: TerminalOutputPayload }),
  EnvelopeBase.extend({ type: z.literal("terminal_closed"), payload: TerminalClosedPayload }),
  EnvelopeBase.extend({ type: z.literal("termination_ack"), payload: TerminationAckPayload }),
  EnvelopeBase.extend({ type: z.literal("source_resolved"), payload: SourceResolvedPayload }),
  EnvelopeBase.extend({ type: z.literal("checkpoint_status"), payload: CheckpointStatusPayload }),
  EnvelopeBase.extend({ type: z.literal("checkpoint_prepared"), payload: CheckpointPreparedPayload }),
  EnvelopeBase.extend({ type: z.literal("checkpoint_installed"), payload: CheckpointInstalledPayload }),
  EnvelopeBase.extend({ type: z.literal("checkpoint_upload_status"), payload: CheckpointUploadStatusPayload }),
  EnvelopeBase.extend({ type: z.literal("output_published"), payload: OutputPublishedPayload }),
  EnvelopeBase.extend({ type: z.literal("restore_status"), payload: RestoreStatusPayload }),
  EnvelopeBase.extend({
    type: z.literal("conversation_message"),
    payload: ConversationMessagePayload,
  }),
  EnvelopeBase.extend({ type: z.literal("attachment_ack"), payload: AttachmentAckPayload }),
  EnvelopeBase.extend({ type: z.literal("attachment_result"), payload: AttachmentResultPayload }),
  EnvelopeBase.extend({
    type: z.literal("attachment_resolved"),
    payload: AttachmentResolvedPayload,
  }),
]);

export type AgentFrame = z.infer<typeof AgentFrameSchema>;

// --- Server -> Agent frames ---

export const RegisteredAckPayload = z.object({
  credentials: z.array(WorkspaceCredentialSchema).max(64).default([]),
  epoch: z.number().int().positive(),
  reconnect_credential: z.string().optional(),
  limits: z.object({
    max_frame_bytes: z.number().int().positive(),
    max_inflight_relay: z.number().int().positive(),
    log_chunk_bytes: z.number().int().positive(),
    heartbeat_seconds: z.number().int().positive(),
  }),
  exec: ExecSpecSchema,
});

export const ProxyRequestPayload = z.object({
  request_id: z.uuid(),
  service: z.string(),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]),
  path: z.string(),
  query: z.record(z.string(), z.string()).default({}),
  headers: z.record(z.string(), z.string()).default({}),
  body_b64: z.string().optional(),
  deadline_ms: z.number().int().positive(),
});

export const SignalPayload = z.object({
  signal: z.enum(["TERM", "KILL"]),
});

export const HealthProbePayload = z.object({
  service: z.string(),
});

export const ShutdownPayload = z.object({
  reason: z.string().max(512),
});

export const PrepareCheckpointPayload = z.object({
  operation_id: z.uuid(),
  deadline_ms: z.number().int().positive(),
});

export const ServerFrameSchema = z.discriminatedUnion("type", [
  EnvelopeBase.extend({ type: z.literal("screenshot_capture"), payload: ScreenshotCapturePayload }),
  EnvelopeBase.extend({ type: z.literal("preview_socket"), payload: PreviewSocketPayload }),
  EnvelopeBase.extend({ type: z.literal("credential_renewed"), payload: CredentialRenewedPayload }),
  EnvelopeBase.extend({ type: z.literal("credential_installed_ack"), payload: CredentialInstalledPayload }),
  EnvelopeBase.extend({ type: z.literal("setup_complete_ack"), payload: z.object({ request_id: z.uuid() }) }),
  EnvelopeBase.extend({ type: z.literal("registered_ack"), payload: RegisteredAckPayload }),
  EnvelopeBase.extend({ type: z.literal("proxy_request"), payload: ProxyRequestPayload }),
  EnvelopeBase.extend({ type: z.literal("proxy_stream_ack"), payload: ProxyStreamAckPayload }),
  EnvelopeBase.extend({
    type: z.literal("proxy_stream_cancel"),
    payload: ProxyStreamCancelPayload,
  }),
  EnvelopeBase.extend({ type: z.literal("terminal_open"), payload: TerminalOpenPayload }),
  EnvelopeBase.extend({ type: z.literal("terminal_input"), payload: TerminalInputPayload }),
  EnvelopeBase.extend({ type: z.literal("terminal_resize"), payload: TerminalResizePayload }),
  EnvelopeBase.extend({ type: z.literal("terminal_close"), payload: TerminalClosePayload }),
  EnvelopeBase.extend({ type: z.literal("signal"), payload: SignalPayload }),
  EnvelopeBase.extend({ type: z.literal("health_probe"), payload: HealthProbePayload }),
  EnvelopeBase.extend({ type: z.literal("shutdown"), payload: ShutdownPayload }),
  EnvelopeBase.extend({
    type: z.literal("prepare_checkpoint"),
    payload: PrepareCheckpointPayload,
  }),
  EnvelopeBase.extend({ type: z.literal("prepare_checkpoint_archive"), payload: PrepareCheckpointArchivePayload }),
  EnvelopeBase.extend({ type: z.literal("checkpoint_upload"), payload: CheckpointUploadPayload }),
  EnvelopeBase.extend({ type: z.literal("attachment_start"), payload: AttachmentStartPayload }),
  EnvelopeBase.extend({ type: z.literal("attachment_chunk"), payload: AttachmentChunkPayload }),
  EnvelopeBase.extend({ type: z.literal("attachment_finish"), payload: AttachmentFinishPayload }),
  EnvelopeBase.extend({ type: z.literal("attachment_abort"), payload: AttachmentAbortPayload }),
  EnvelopeBase.extend({
    type: z.literal("attachment_resolve"),
    payload: AttachmentResolvePayload,
  }),
]);

export type ServerFrame = z.infer<typeof ServerFrameSchema>;

export type ProxyRequest = z.infer<typeof ProxyRequestPayload>;
export type ProxyResponse = z.infer<typeof ProxyResponsePayload>;
