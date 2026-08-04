import { z } from "@hono/zod-openapi";
import { ErrorEnvelopeSchema } from "@pstdio/pocketcoder-contracts";

export const IdempotencyHeadersSchema = z.object({
	"Idempotency-Key": z.string().min(1).max(256).openapi({
		description:
			"Opaque caller key. Reusing it with the same request returns the original result; a different request returns idempotency.conflict.",
		example: "onefin-task-018f6f0e",
	}),
});

function errorResponse(description: string) {
	return {
		description,
		content: { "application/json": { schema: ErrorEnvelopeSchema } },
	};
}

export const COMMON_ERROR_RESPONSES = {
	400: errorResponse("Invalid request"),
	401: errorResponse("Missing or invalid machine key"),
	403: errorResponse("Machine key lacks the required scope"),
} as const;
