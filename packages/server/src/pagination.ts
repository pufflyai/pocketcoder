import { ApiError } from "@pstdio/pocketcoder-contracts";

type CursorValue = string | number;

export function encodeCursor(scope: string, value: CursorValue) {
  return Buffer.from(JSON.stringify({ scope, value }), "utf8").toString("base64url");
}

export function decodeCursor(scope: string, cursor: string | undefined): CursorValue | undefined {
  if (!cursor) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (
      typeof decoded !== "object" ||
      decoded === null ||
      !("scope" in decoded) ||
      decoded.scope !== scope ||
      !("value" in decoded) ||
      (typeof decoded.value !== "string" && typeof decoded.value !== "number")
    ) {
      throw new Error("invalid cursor payload");
    }
    return decoded.value;
  } catch {
    throw new ApiError("validation.invalid", "Invalid pagination cursor.");
  }
}

export function decodeStringCursor(scope: string, cursor: string | undefined) {
  const value = decodeCursor(scope, cursor);
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new ApiError("validation.invalid", "Invalid pagination cursor.");
  }
  return value;
}

export function decodeSequenceCursor(scope: string, cursor: string | undefined) {
  const value = decodeCursor(scope, cursor);
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ApiError("validation.invalid", "Invalid pagination cursor.");
  }
  return value;
}
