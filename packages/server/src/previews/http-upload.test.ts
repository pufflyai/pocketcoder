import { expect, test } from "bun:test";
import { waitFor } from "../testing/e2e-test-support";
import { createPreviewFlow } from "./preview-flow-fixture";

test("a stalled revoked upload receives 401 before its request body closes", async () => {
  const fixture = await createPreviewFlow();
  const abort = new AbortController();
  let upload: Promise<Response> | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  try {
    await waitFor(
      async () => (await fixture.server.store.getWorkspace(fixture.workspace.id))?.state === "ready",
      5000,
      "ready",
    );
    const opened = new URL(
      (
        await fixture.publicClient.previews.open(fixture.workspace.id, "web", {
          session: { mode: "embedded", parentOrigin: fixture.publicViews.parents[0] ?? "" },
        })
      ).url,
    );
    const headers = { host: opened.host, "x-forwarded-host": opened.host, "x-forwarded-proto": "https" };
    const exchange = await fetch(`${fixture.baseUrl}${opened.pathname}${opened.search}`, {
      headers,
      redirect: "manual",
    });
    expect(exchange.status).toBe(303);
    const cookie = exchange.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    upload = fetch(`${fixture.baseUrl}/delayed-upload`, {
      method: "POST",
      headers: { ...headers, cookie, origin: opened.origin },
      signal: abort.signal,
      body: new ReadableStream<Uint8Array>({
        start(value) {
          controller = value;
          value.enqueue(new Uint8Array([1]));
        },
      }),
    });
    void upload.catch(() => {});
    await Bun.sleep(400);
    await fixture.server.store.revokeMachineKey(fixture.server.keyId, new Date());
    const response = await Promise.race([
      upload,
      Bun.sleep(1500).then(() => {
        throw new Error("Revoked upload waited for request EOF");
      }),
    ]);
    expect(response.status).toBe(401);
    expect(fixture.uploadRequests).toBe(0);
    await response.text();
  } finally {
    abort.abort();
    try {
      controller?.close();
    } catch {}
    if (upload) await Promise.allSettled([upload]);
    await fixture.close();
  }
}, 10_000);

test("an oversized open upload receives 413 before EOF and never reaches the workspace", async () => {
  const fixture = await createPreviewFlow();
  const abort = new AbortController();
  let upload: Promise<Response> | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  try {
    await waitFor(
      async () => (await fixture.server.store.getWorkspace(fixture.workspace.id))?.state === "ready",
      5000,
      "ready",
    );
    const opened = new URL((await fixture.client.previews.open(fixture.workspace.id, "web")).url);
    const headers = { host: opened.host };
    const exchange = await fetch(`${fixture.baseUrl}${opened.pathname}${opened.search}`, {
      headers,
      redirect: "manual",
    });
    expect(exchange.status).toBe(303);
    const cookie = exchange.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    upload = fetch(`${fixture.baseUrl}/delayed-upload`, {
      method: "POST",
      headers: { ...headers, cookie, origin: opened.origin },
      signal: abort.signal,
      body: new ReadableStream<Uint8Array>({
        start(value) {
          controller = value;
          value.enqueue(new Uint8Array(65537));
        },
      }),
    });
    void upload.catch(() => {});
    const response = await Promise.race([
      upload,
      Bun.sleep(1500).then(() => {
        throw new Error("Oversized upload waited for request EOF");
      }),
    ]);
    expect(response.status).toBe(413);
    expect(fixture.uploadRequests).toBe(0);
    await response.text();
  } finally {
    abort.abort();
    try {
      controller?.close();
    } catch {}
    if (upload) await Promise.allSettled([upload]);
    await fixture.close();
  }
}, 10_000);
