import { PREVIEW_COOKIE } from "./preview";

const REQUEST_HEADERS = new Set([
  "accept",
  "accept-language",
  "content-type",
  "if-none-match",
  "if-modified-since",
  "range",
  "origin",
]);
const RESPONSE_HEADERS = new Set([
  "content-type",
  "cache-control",
  "etag",
  "last-modified",
  "content-range",
  "accept-ranges",
  "location",
  "content-security-policy",
  "x-content-type-options",
  "x-frame-options",
]);

export function previewRequestHeaders(headers: Headers) {
  const result: Record<string, string> = {};
  for (const [name, value] of headers) if (REQUEST_HEADERS.has(name)) result[name] = value;
  const cookies = headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .filter((part) => !reservedCookie(part.split("=", 1)[0] ?? ""));
  if (cookies?.length) result.cookie = cookies.join("; ");
  return result;
}

function reservedCookie(name: string) {
  const lower = name.toLowerCase();
  return lower === PREVIEW_COOKIE || lower.startsWith("pc-") || lower.startsWith("__host-");
}

export function previewResponseHeaders(headers: Headers) {
  const result: Record<string, string> = {};
  for (const [name, value] of headers) if (RESPONSE_HEADERS.has(name)) result[name] = value;
  // Redirects stay on the isolated preview host.
  if (result.location && (!result.location.startsWith("/") || result.location.startsWith("//"))) delete result.location;
  return result;
}

export function previewCookies(headers: Headers) {
  return headers.getSetCookie().filter((value) => {
    const name = value.split("=", 1)[0]?.trim().toLowerCase();
    return (
      name &&
      name !== PREVIEW_COOKIE &&
      !name.startsWith("pc-") &&
      !name.startsWith("__host-") &&
      !/(?:^|;)\s*domain\s*=/i.test(value)
    );
  });
}
