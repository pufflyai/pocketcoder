import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

const ORIGIN = "https://api.digitalocean.com";
const Paging = z.object({
  meta: z.object({ total: z.number().int().nonnegative() }),
  links: z.object({ pages: z.object({ next: z.string().url().optional() }).optional() }).optional(),
});
export const pending = (reason: string) => new Error(`DigitalOcean cleanup is pending: ${reason}.`);

export function digitalOceanNextPage(next: string | undefined, current: URL) {
  if (!next) return null;
  const url = new URL(next);
  if (url.origin !== ORIGIN || url.pathname !== current.pathname || url.username || url.password || url.hash)
    throw pending("next page leaves the inventory endpoint");
  const page = Number(url.searchParams.get("page"));
  if (!Number.isSafeInteger(page) || page !== Number(current.searchParams.get("page")) + 1)
    throw pending("next page is not sequential");
  for (const [key, value] of url.searchParams) {
    if (url.searchParams.getAll(key).length !== 1 || (key !== "page" && current.searchParams.get(key) !== value))
      throw pending("next page changes inventory scope");
  }
  const result = new URL(current);
  result.searchParams.set("page", String(page));
  return result;
}

// Every page must be present and every repeated provider ID must keep the same identity.
export function digitalOceanPages<T extends { id: string | number }>(
  pages: unknown[],
  key: string,
  item: z.ZodType<T>,
) {
  const items = new Map<string | number, T>();
  if (!pages.length) throw pending("inventory has no pages");
  for (const [index, body] of pages.entries()) {
    const paging = Paging.parse(body);
    if (Boolean(paging.links?.pages?.next) !== index < pages.length - 1)
      throw pending("inventory paging is unfinished");
    for (const entry of z.object({ [key]: z.array(item) }).parse(body)[key] as T[]) {
      const previous = items.get(entry.id);
      if (previous && !isDeepStrictEqual(previous, entry)) throw pending("repeated provider ID changes identity");
      items.set(entry.id, entry);
    }
  }
  return [...items.values()];
}

async function json(response: Response) {
  if (!response.body) throw pending("provider response has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 2 * 1024 * 1024) throw pending("provider page exceeds the request bound");
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString()) as unknown;
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

export function digitalOceanApi(credential: { token: string; expiresAt: Date }) {
  const token = z
    .string()
    .min(1)
    .regex(/^[^\r\n]+$/)
    .parse(credential.token);
  const expiresAt = credential.expiresAt.getTime();
  function lifetime() {
    const remaining = expiresAt - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) throw pending("provider credential expired");
    return Math.max(1, Math.min(30_000, remaining));
  }
  lifetime();
  async function request(url: URL, method: "GET" | "DELETE") {
    const response = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(lifetime()),
    });
    try {
      lifetime();
      if (method === "DELETE") {
        if (response.status !== 204) throw pending(`provider DELETE returned ${response.status}`);
        return null;
      }
      if (response.status === 404) return null;
      if (response.status !== 200) throw pending(`provider GET returned ${response.status}`);
      const body = await json(response);
      lifetime();
      return body;
    } finally {
      await response.body?.cancel();
    }
  }
  const endpoint = (path: string) => new URL(path, ORIGIN);
  // A missing first page means the listed parent is absent. A page that disappears later is unclear.
  async function pages(path: string, params: Record<string, string> = {}) {
    let url: URL | null = endpoint(path);
    for (const [key, value] of Object.entries({ ...params, per_page: "200", page: "1" }))
      url.searchParams.set(key, value);
    const result: unknown[] = [];
    while (url) {
      const body = await request(url, "GET");
      if (body === null) {
        if (!result.length) return null;
        throw pending("inventory page disappeared");
      }
      result.push(body);
      url = digitalOceanNextPage(Paging.parse(body).links?.pages?.next, url);
    }
    return result;
  }
  return { lifetime, request, endpoint, pages };
}
export type DigitalOceanApi = ReturnType<typeof digitalOceanApi>;
