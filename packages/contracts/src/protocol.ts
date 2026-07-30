import { z } from "zod";
import { HarnessSchema, ServiceSchema, SetupStepSchema, TimeoutsSchema } from "./template";

// The pocketcoder-agent supervisor protocol: JSON text frames over one
// outbound WSS connection per workspace. There is no worker lease, arbitrary
// command execution, shell stream, tunnel, or file API in this protocol.

export const PROTOCOL_VERSION = 1;

export const MAX_FRAME_BYTES = 1_048_576;

// Registration headers on the upgrade request.
export const HEADER_PROTOCOL = "x-pocketcoder-protocol";
export const HEADER_WORKSPACE = "x-pocketcoder-workspace";
export const HEADER_REGISTRATION = "x-pocketcoder-registration";
export const HEADER_RECONNECT = "x-pocketcoder-reconnect";

const EnvelopeBase = z.object({
	v: z.literal(PROTOCOL_VERSION),
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

export const AgentFrameSchema = z.discriminatedUnion("type", [
	EnvelopeBase.extend({ type: z.literal("registered"), payload: RegisteredPayload }),
	EnvelopeBase.extend({ type: z.literal("heartbeat"), payload: HeartbeatPayload }),
	EnvelopeBase.extend({ type: z.literal("process_state"), payload: ProcessStatePayload }),
	EnvelopeBase.extend({ type: z.literal("service_health"), payload: ServiceHealthPayload }),
	EnvelopeBase.extend({ type: z.literal("log_chunk"), payload: LogChunkPayload }),
	EnvelopeBase.extend({ type: z.literal("proxy_response"), payload: ProxyResponsePayload }),
	EnvelopeBase.extend({ type: z.literal("termination_ack"), payload: TerminationAckPayload }),
]);

export type AgentFrame = z.infer<typeof AgentFrameSchema>;

// --- Server -> Agent frames ---

// The exec spec delivers the template-owned setup commands, harness command,
// service allowlist, and timeouts to the supervisor at registration time, so
// custom setup and custom harnesses require no image rebuild.
export const ExecSpecSchema = z.object({
	setup: z.array(SetupStepSchema),
	harness: HarnessSchema,
	env: z.record(z.string(), z.string()),
	services: z.record(z.string(), ServiceSchema),
	timeouts: TimeoutsSchema,
});

export type ExecSpec = z.infer<typeof ExecSpecSchema>;

export const RegisteredAckPayload = z.object({
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
	method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
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

export const ServerFrameSchema = z.discriminatedUnion("type", [
	EnvelopeBase.extend({ type: z.literal("registered_ack"), payload: RegisteredAckPayload }),
	EnvelopeBase.extend({ type: z.literal("proxy_request"), payload: ProxyRequestPayload }),
	EnvelopeBase.extend({ type: z.literal("signal"), payload: SignalPayload }),
	EnvelopeBase.extend({ type: z.literal("health_probe"), payload: HealthProbePayload }),
	EnvelopeBase.extend({ type: z.literal("shutdown"), payload: ShutdownPayload }),
]);

export type ServerFrame = z.infer<typeof ServerFrameSchema>;

export type ProxyRequest = z.infer<typeof ProxyRequestPayload>;
export type ProxyResponse = z.infer<typeof ProxyResponsePayload>;

// The provider input file mounted read-only into each workspace. It contains
// no machine key, provider credential, or LLM credential.
export const ProviderInputSchema = z.object({
	workspace_id: z.uuid(),
	server_url: z.string(),
	registration_secret: z.string(),
	template_digest: z.string(),
	template_name: z.string().default("unknown"),
	template_version: z.string().default("unknown"),
	launch_input: z.record(z.string(), z.unknown()).optional(),
});

export type ProviderInput = z.infer<typeof ProviderInputSchema>;
