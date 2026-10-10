import { expect, test } from "bun:test";
import { waitFor } from "../testing/e2e-test-support";
import { createPreviewFlow } from "./preview-flow-fixture";

for (const mode of ["local", "embedded"] as const)
  test(`real ${mode} supervisor relays assets and live reload, strips authority, and closes a revoked browser socket`, async () => {
    const fixture = await createPreviewFlow();
    const { captured, socketOrigins, server, client, workspace, publicViews, baseUrl, publicClient, previewPort } =
      fixture;
    let socket: WebSocket | undefined;
    const headerAbort = new AbortController();
    const cleanupAbort = new AbortController();
    const requests: Promise<Response>[] = [];
    try {
      await waitFor(
        async () => (await server.store.getWorkspace(workspace.id))?.state === "ready",
        5000,
        "preview workspace ready",
      );
      expect(await client.previews.list(workspace.id)).toEqual([{ name: "web", port: previewPort }]);
      const viewClient = mode === "embedded" ? publicClient : client;
      const minted = await viewClient.previews.open(workspace.id, "web", {
        session: mode === "embedded" ? { mode, parentOrigin: publicViews.parents[0] ?? "" } : { mode },
      });
      const preview = new URL(minted.url);
      const request = (path: string, init: RequestInit = {}) => {
        const pending = fetch(`${baseUrl}${path}`, {
          ...init,
          redirect: "manual",
          signal: AbortSignal.any([cleanupAbort.signal, ...(init.signal ? [init.signal] : [])]),
          headers: {
            host: preview.host,
            ...(mode === "embedded" ? { "x-forwarded-host": preview.host, "x-forwarded-proto": "https" } : {}),
            ...init.headers,
          },
        });
        // Cancellation can precede the assertion that awaits this request.
        void pending.catch(() => {});
        requests.push(pending);
        return pending;
      };
      const exchange = await request(preview.pathname + preview.search);
      expect(exchange.status).toBe(303);
      const cookie = exchange.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
      const page = await request("/", {
        headers: { cookie, authorization: `Bearer ${server.token}`, "x-pocketcoder-registration": "standing-secret" },
      });
      expect(await page.text()).toContain("<h1>Preview</h1>");
      const protectedPage = await request("/framing", { headers: { cookie } });
      await protectedPage.text();
      expect(protectedPage.headers.get("content-security-policy")).toContain(
        "default-src 'self'; frame-ancestors 'none'",
      );
      expect(protectedPage.headers.get("x-frame-options")).toBe("DENY");
      expect(page.headers.get("content-security-policy")).toContain(
        mode === "embedded" ? (publicViews.parents[0] ?? "") : "frame-ancestors 'none'",
      );
      expect(await (await request("/style.css", { headers: { cookie } })).text()).toBe("body{color:red}");
      expect((await request("/redirect", { headers: { cookie } })).headers.get("location")).toBe("/style.css");
      expect(
        (await request("/", { method: "POST", headers: { cookie, origin: "http://foreign.localhost" }, body: "bad" }))
          .status,
      ).toBe(401);
      expect(
        (await request("/", { method: "POST", headers: { cookie, origin: preview.origin }, body: "ok" })).status,
      ).toBe(200);
      const slow = await request("/slow", { headers: { cookie } });
      const slowBody = slow.arrayBuffer().then(
        () => "completed",
        () => "closed",
      );
      await waitFor(async () => server.hub.activeStreamCount(workspace.id) === 1, 1000, "slow stream");
      expect((await client.workspaces.get(workspace.id)).state).toBe("ready");
      const liveUrl = new URL(`${baseUrl}/reload`);
      liveUrl.protocol = "ws:";
      const liveSocket = new WebSocket(liveUrl, {
        headers: {
          host: preview.host,
          cookie: `${cookie}; app-session=allowed`,
          origin: preview.origin,
          ...(mode === "embedded" ? { "x-forwarded-host": preview.host, "x-forwarded-proto": "https" } : {}),
        },
      } as unknown as string[]);
      socket = liveSocket;
      await new Promise<void>((resolve, reject) => {
        liveSocket.onopen = () => resolve();
        liveSocket.onerror = () => reject(new Error("preview socket failed"));
      });
      const reply = new Promise<string>((resolve) => {
        liveSocket.onmessage = (event) => resolve(String(event.data));
      });
      socket.send("reload");
      expect(await reply).toBe("reload");
      expect(socketOrigins).toEqual([preview.origin]);
      expect(
        captured.every(
          (headers) =>
            !headers.has("authorization") &&
            !headers.get("cookie")?.includes("pc-preview-session") &&
            !headers.get("cookie")?.includes("__Host-pc-view") &&
            !headers.has("x-pocketcoder-registration"),
        ),
      ).toBe(true);
      expect(captured.some((headers) => headers.get("cookie") === "app-session=allowed")).toBe(true);
      const closed = new Promise<void>((resolve) => {
        liveSocket.onclose = () => resolve();
      });
      let uploadController: ReadableStreamDefaultController<Uint8Array> | undefined;
      const uploading = request("/delayed-upload", {
        method: "POST",
        headers: { cookie, origin: preview.origin },
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            uploadController = controller;
            controller.enqueue(new Uint8Array([1]));
          },
        }),
      });
      await Bun.sleep(400);
      const waiting = request("/waiting-headers", { headers: { cookie }, signal: headerAbort.signal });
      await waitFor(async () => server.hub.activeStreamCount(workspace.id) === 2, 1000, "waiting for upstream headers");
      await server.store.revokeMachineKey(server.keyId, new Date());
      await closed;
      try {
        uploadController?.close();
      } catch {}
      expect((await uploading).status).toBe(401);
      expect(fixture.uploadRequests).toBe(0);
      await waitFor(async () => server.hub.activeStreamCount(workspace.id) === 0, 1000, "revoked HTTP requests close");
      expect((await waiting).status).toBe(401);
      expect((await request("/", { headers: { cookie } })).status).toBe(401);
      expect(await slowBody).toBe("closed");
    } finally {
      headerAbort.abort();
      cleanupAbort.abort();
      socket?.close();
      await Promise.allSettled(requests);
      await fixture.close();
    }
  }, 15_000);
