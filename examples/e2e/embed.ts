import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PocketCoderClient } from "@pstdio/pocketcoder-sdk";
import { startDisplayDemo } from "./display-runtime";
import { checkEmbedBrowsers } from "./embed-browsers";
import { startEmbedGateway } from "./embed-gateway";
import { command, freePort } from "./local-process";

const directory = await mkdtemp(join(tmpdir(), "pc-embed-"));
const port = freePort();
const apiOrigin = `https://api.localtest.me:${port}`;
const parentOrigin = `https://app.localtest.me:${port}`;
const origin = `https://lvh.me:${port}`;
const key = join(directory, "key.pem"),
  cert = join(directory, "cert.pem");
await command(
  [
    "openssl",
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    key,
    "-out",
    cert,
    "-days",
    "1",
    "-subj",
    "/CN=localtest.me",
    "-addext",
    "subjectAltName=DNS:*.localtest.me,DNS:*.lvh.me,DNS:lvh.me",
  ],
  { quiet: true },
);
const demo = await startDisplayDemo("browser", undefined, {
  POCKETCODER_PUBLIC_VIEWS: JSON.stringify({
    apiOrigin,
    origin,
    parents: [parentOrigin],
    trustedIngress: ["127.0.0.1"],
  }),
});
const publicClient = new PocketCoderClient({
  baseUrl: apiOrigin,
  apiKey: "unused",
  fetch: (async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    headers.delete("authorization");
    return demo.client.raw(url.pathname, {
      ...init,
      headers: { ...Object.fromEntries(headers), "x-forwarded-host": url.host, "x-forwarded-proto": "https" },
    });
  }) as typeof fetch,
});
const gateway = startEmbedGateway({
  port,
  key,
  cert,
  apiOrigin,
  parentOrigin,
  baseUrl: demo.baseUrl,
  client: publicClient,
  workspaceId: demo.workspace.id,
});
try {
  const results = await checkEmbedBrowsers(parentOrigin, directory);
  console.log(JSON.stringify({ result: "passed", results, evidence: directory }));
  if (process.argv.includes("--browser")) {
    console.log(`BROWSER_URL=${parentOrigin}`);
    const reader = Bun.stdin.stream().getReader();
    await reader.read();
    reader.releaseLock();
  }
} finally {
  await gateway.stop(true);
  await demo.close();
  if (!process.argv.includes("--keep")) await rm(directory, { recursive: true, force: true });
}
