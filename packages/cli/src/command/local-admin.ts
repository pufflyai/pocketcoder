import { join, resolve } from "node:path";
import { KeyIssueResponseSchema } from "@pstdio/pocketcoder-contracts";
import type { Flags } from "./cli-context";

export async function requestLocalAdministration(flags: Flags, path: string, body?: unknown, timeoutMs = 5000) {
  const directory = resolve(typeof flags.dir === "string" ? flags.dir : (process.env.POCKETCODER_DIR ?? "./pc_data"));
  let response: Response;
  try {
    response = await fetch(`http://localhost${path}`, {
      unix: join(directory, "admin.sock"),
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(
      `Cannot reach the local admin socket in ${directory}. Start pocketcoder serve with that data folder.`,
      { cause: error },
    );
  }
  if (!response.ok) {
    const result = (await response.json()) as { error: { message: string } };
    throw new Error(result.error.message);
  }
  return (await response.json()) as unknown;
}

export async function requestLocalKey(flags: Flags, path: string, body: unknown) {
  return KeyIssueResponseSchema.parse(await requestLocalAdministration(flags, path, body));
}
