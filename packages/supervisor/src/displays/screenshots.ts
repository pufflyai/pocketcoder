import { type ExecSpec, SCREENSHOT_MAX_BYTES, type ScreenshotCapture } from "@pstdio/pocketcoder-contracts";
import { connectChromium } from "./chromium";
import { captureDesktop } from "./desktop-capture";

async function captureBrowser(signal: AbortSignal) {
  const browser = await connectChromium(
    () => {},
    () => {},
    signal,
  );
  const stop = () => browser.close();
  signal.addEventListener("abort", stop, { once: true });
  try {
    signal.throwIfAborted();
    const result = await browser.command("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
      fromSurface: true,
    });
    if (typeof result.data !== "string" || result.data.length > Math.ceil((SCREENSHOT_MAX_BYTES * 4) / 3))
      throw new Error("Browser screenshot exceeds 4 MiB.");
    const bytes = Buffer.from(result.data, "base64");
    signal.throwIfAborted();
    return bytes;
  } finally {
    signal.removeEventListener("abort", stop);
    browser.close();
  }
}

export class SupervisorScreenshots {
  private active: { abort: AbortController; done: Promise<void> } | null = null;
  constructor(
    private readonly serverUrl: string,
    private readonly exec: () => ExecSpec | null,
  ) {}
  async capture(input: ScreenshotCapture) {
    if (this.active) throw new Error("Screenshot capture is busy.");
    const mode = this.exec()?.display?.mode;
    if (!mode) throw new Error("Screenshot display is unavailable.");
    const url = new URL(input.url);
    if (
      url.origin !== new URL(this.serverUrl).origin ||
      url.pathname !== `/v1/agent/screenshots/${input.output_id}` ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    )
      throw new Error("Screenshot upload must use the controller endpoint.");
    const deadline = Math.min(Date.parse(input.expires_at) - Date.now(), 10_000);
    if (deadline <= 0) throw new Error("Screenshot grant expired.");
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), deadline);
    const done = (async () => {
      const bytes = mode === "browser" ? await captureBrowser(abort.signal) : await captureDesktop(abort.signal);
      if (!bytes.length || bytes.length > SCREENSHOT_MAX_BYTES) throw new Error("Screenshot exceeds 4 MiB.");
      abort.signal.throwIfAborted();
      const response = await fetch(url, {
        method: "PUT",
        headers: { authorization: `Bearer ${input.credential}`, "content-type": "image/png" },
        body: bytes,
        signal: abort.signal,
      });
      if (!response.ok) throw new Error("Screenshot upload was rejected.");
      await response.body?.cancel();
    })();
    this.active = { abort, done };
    try {
      await done;
    } finally {
      clearTimeout(timer);
      this.active = null;
    }
  }
  async cancel() {
    const active = this.active;
    active?.abort.abort();
    await active?.done.catch(() => {});
  }
}
