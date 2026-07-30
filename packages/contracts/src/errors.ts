// Stable error codes shared by the REST API, relay, and CLI. The error
// envelope is the only error shape callers ever see; provider errors, SQL
// errors, and stack traces never appear in responses.

export const ERROR_CODES = {
	"auth.invalid_key": 401,
	"auth.missing_scope": 403,
	"auth.disabled_principal": 403,
	"validation.invalid": 400,
	"idempotency.conflict": 409,
	"capacity.queue_full": 429,
	"template.not_found": 404,
	"template.version_not_found": 404,
	"template.not_authorized": 403,
	"workspace.not_found": 404,
	"workspace.not_ready": 409,
	"workspace.terminal": 410,
	"workspace.disconnected": 503,
	"workspace.persistence_not_enabled": 409,
	"workspace.preserving": 409,
	"checkpoint.not_found": 404,
	"checkpoint.not_ready": 409,
	"checkpoint.none_ready": 409,
	"checkpoint.corrupt": 409,
	"checkpoint.quota_exceeded": 413,
	"checkpoint.in_use": 409,
	"restore.template_not_authorized": 403,
	"restore.image_unavailable": 409,
	"restore.incompatible": 409,
	"operation.conflict": 409,
	"source.not_allowed": 422,
	"source.invalid_revision": 422,
	"secret.unavailable": 503,
	"storage.capacity_exhausted": 507,
	"relay.body_too_large": 413,
	"relay.route_not_allowed": 422,
	"relay.deadline_exceeded": 504,
	"relay.upstream_error": 502,
	"internal.error": 500,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export interface ErrorEnvelope {
	error: {
		code: ErrorCode;
		message: string;
		request_id: string;
	};
}

export class ApiError extends Error {
	readonly code: ErrorCode;
	readonly status: number;

	constructor(code: ErrorCode, message: string) {
		super(message);
		this.code = code;
		this.status = ERROR_CODES[code];
	}
}

export function errorEnvelope(code: ErrorCode, message: string, requestId: string): ErrorEnvelope {
	return { error: { code, message, request_id: requestId } };
}
