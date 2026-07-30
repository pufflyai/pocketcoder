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
