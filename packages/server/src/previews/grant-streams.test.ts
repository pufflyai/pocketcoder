import { expect, test } from "bun:test";
import { PREVIEW_AUTHORIZATION_CHECK_MS } from "@pstdio/pocketcoder-contracts";
import { waitFor } from "../testing/e2e-test-support";
import { authed } from "../testing/test-server.test";
import { createPreviewFlow } from "./preview-flow-fixture";

test.each(["direct", "delayed", "expiry"])(
  "%s grant loss closes only its user's real HTTP and WebSocket streams",
  async (mode) => {
    const f = await createPreviewFlow();
    const sockets: WebSocket[] = [];
    try {
      await waitFor(async () => (await f.server.store.getWorkspace(f.workspace.id))?.state === "ready", 5000, "ready");
      const open = async (subject: string) => {
        const grantId = await f.grant(subject, mode === "expiry" && subject === "U" ? 1500 : 60000);
        const url = new URL(
          (await f.publicClient.previews.open(f.workspace.id, "web", { session: { mode: "top_level" }, grantId })).url,
        );
        const headers = { host: url.host, "x-forwarded-host": url.host, "x-forwarded-proto": "https" };
        const exchange = await fetch(`${f.baseUrl}${url.pathname}${url.search}`, { headers, redirect: "manual" });
        const cookie = exchange.headers.get("set-cookie")?.split(";")[0] ?? "";
        const socket = new WebSocket(f.baseUrl.replace("http:", "ws:") + "/reload", {
          headers: { ...headers, cookie, origin: url.origin },
        } as unknown as string[]);
        sockets.push(socket);
        await new Promise<void>((resolve, reject) => {
          socket.onopen = () => resolve();
          socket.onerror = () => reject(new Error("Preview socket failed"));
        });
        return { grantId, socket, headers: { ...headers, cookie } };
      };
      const u = await open("U");
      const v = await open("V");
      const response = await fetch(`${f.baseUrl}/slow`, { headers: u.headers });
      const body = response.arrayBuffer().then(
        () => "complete",
        () => "closed",
      );
      const closed = new Promise<void>((resolve) => {
        u.socket.onclose = () => resolve();
      });
      const started = performance.now();
      if (mode === "direct") {
        const revoke = await f.server.app.request(
          `${f.publicViews.apiOrigin}/v1/workspaces/${f.workspace.id}/preview-grants/${u.grantId}/revoke`,
          authed(f.server.token, { method: "POST", body: "{}" }),
        );
        expect([200, 202]).toContain(revoke.status);
      } else if (mode === "delayed") {
        // A second controller commits revocation without this controller's local notification.
        await f.server.store.previewGrants.revoke(u.grantId, new Date());
      }
      await Promise.race([
        closed,
        Bun.sleep(mode === "expiry" ? 2500 : 1000).then(() => {
          throw new Error("Grant socket did not close");
        }),
      ]);
      expect(await body).toBe("closed");
      expect(performance.now() - started).toBeLessThan(mode === "expiry" ? 2500 : PREVIEW_AUTHORIZATION_CHECK_MS + 750);
      expect(PREVIEW_AUTHORIZATION_CHECK_MS).toBe(250);
      const reply = new Promise<string>((resolve) => {
        v.socket.onmessage = (event) => resolve(String(event.data));
      });
      v.socket.send("still-live");
      expect(await reply).toBe("still-live");
      const receipt = await f.server.app.request(
        `${f.publicViews.apiOrigin}/v1/workspaces/${f.workspace.id}/preview-grants/${u.grantId}`,
        authed(f.server.token),
      );
      expect(((await receipt.json()) as { pendingStreams: number }).pendingStreams).toBe(0);
      expect((await fetch(`${f.baseUrl}/.pc/check`, { headers: u.headers })).status).toBe(401);
      expect((await fetch(`${f.baseUrl}/.pc/check`, { headers: v.headers })).status).toBe(204);
    } finally {
      for (const socket of sockets) socket.close();
      await f.close();
    }
  },
  10000,
);
