import { randomUUID } from "node:crypto";
import { PocketCoderClient } from "@pstdio/pocketcoder-sdk";
import { chromium, type Page } from "playwright";
import type { createKubernetesCluster } from "./kubernetes-cluster";
import { waitFor } from "./local-process";

type Owner = {
  id: string;
  namespace: string;
  api_origin: string;
  token: string;
  principalId: string;
  client: PocketCoderClient;
};

const label = (owner: Owner) => owner.id.replaceAll("-", "");
const frameShown = (page: Page) =>
  page.waitForFunction(() => (document.querySelector("#browser-screen") as HTMLImageElement | null)?.naturalWidth);

// Drives the hosted viewer in Chromium: input, cookie scope, account zones and revocation.
export async function checkBrowserViews(options: {
  cluster: Awaited<ReturnType<typeof createKubernetesCluster>>;
  ca: string;
  one: Owner;
  two: Owner;
  workspaceId: string;
  pod: string;
}) {
  const { cluster, ca, one, two, workspaceId } = options;
  const browser = await chromium.launch();
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
  try {
    const page = await context.newPage();
    const control = new URL(
      (await one.client.displays.open(workspaceId, true, { session: { mode: "top_level" } })).url,
    );
    await page.goto(control.href);
    if (new URL(page.url()).search) throw new Error("The hosted view kept its token");
    await page.locator("#status", { hasText: "Control active" }).waitFor();
    await frameShown(page);
    const screen = await page.locator("#browser-screen").boundingBox();
    if (!screen) throw new Error("Viewer screen is missing");
    // The fixture input sits at (150, 125) on the 1280x800 remote screen.
    await page.mouse.click(screen.x + (screen.width * 150) / 1280, screen.y + (screen.height * 125) / 800);
    await page.keyboard.type("chromium-typed");
    await waitFor(
      () =>
        cluster.kube(["-n", one.namespace, "exec", options.pod, "--", "cat", "/tmp/browser-proof"]).then(
          (value) => value.includes("chromium-typed"),
          () => false,
        ),
      15_000,
      "Chromium input in the hosted workspace",
    );
    const cookie = (await context.cookies()).find((item) => item.name === "__Host-pc-view");
    if (cookie?.domain !== control.hostname || !cookie.secure || !cookie.httpOnly || cookie.sameSite !== "Lax")
      throw new Error(`Hosted view cookie is not host-only and Secure: ${JSON.stringify({ ...cookie, value: "…" })}`);
    const otherZone = new URL(control.origin);
    otherZone.hostname = control.hostname.replace(`.${label(one)}.`, `.${label(two)}.`);
    const crossed = await page.goto(otherZone.href);
    if (!crossed || crossed.ok()) throw new Error("The view opened on another account's zone");

    const issued = await one.client.keys.issue(one.principalId, {
      request_id: randomUUID(),
      scopes: ["display:view", "workspaces:read"],
      templates: ["browser"],
      expires_at: new Date(Date.now() + 120_000).toISOString(),
    });
    if (!issued.token) throw new Error("Finite display key missing");
    const finite = new PocketCoderClient({
      baseUrl: one.api_origin,
      apiKey: issued.token,
      fetch: ((input, init) => fetch(input, { ...init, tls: { ca } })) as typeof fetch,
    });
    const viewer = await context.newPage();
    await viewer.goto((await finite.displays.open(workspaceId, false, { session: { mode: "top_level" } })).url);
    await viewer.locator("#status", { hasText: "View only" }).waitFor();
    await frameShown(viewer);
    await one.client.keys.revoke(one.principalId, issued.key.id);
    await viewer.locator("#status", { hasText: "Disconnected" }).waitFor({ timeout: 5000 });
    return {
      control: "Chromium typing reached the workspace",
      cookie: "host-only, Secure, HttpOnly, SameSite=Lax",
      otherAccountZone: `status ${crossed.status()}`,
      revocation: "Chromium viewer disconnected",
    };
  } finally {
    await context.close();
    await browser.close();
  }
}
