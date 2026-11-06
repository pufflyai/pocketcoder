import { ApiError, ErrorEnvelopeSchema } from "@pstdio/pocketcoder-contracts";
import { bodyLimit } from "hono/body-limit";
import { COMMON_ERROR_RESPONSES } from "./shared-routes";

export function managedBodyLimit(maxSize: number) {
  return bodyLimit({
    maxSize,
    onError: () => {
      throw new ApiError("request.body_too_large", `Request body exceeds ${maxSize} bytes.`);
    },
  });
}
const error = (description: string) => ({
  description,
  content: { "application/json": { schema: ErrorEnvelopeSchema } },
});
export const MANAGED_ERROR_RESPONSES = {
  ...COMMON_ERROR_RESPONSES,
  404: error("Resource is absent or outside the caller's authority"),
  409: error("Immutable identity conflicts or an operation cannot proceed"),
  410: error("Resource retention ended"),
  412: error("A write precondition is missing or stale"),
  413: error("Request body exceeds its finite byte limit"),
  429: error("Runtime allowance is exhausted"),
  503: error("Required runtime authority is unavailable"),
} as const;
