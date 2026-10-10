import { expect, test } from "bun:test";
import { connectChromium } from "./chromium";

test("capture cancellation stops stalled Chromium discovery promptly", async () => {
  const discovery = Bun.serve({ hostname: "127.0.0.1", port: 9222, fetch: () => new Promise<Response>(() => {}) });
  try {
    const started = performance.now();
    await expect(
      connectChromium(
        () => {},
        () => {},
        AbortSignal.timeout(50),
      ),
    ).rejects.toThrow();
    expect(performance.now() - started).toBeLessThan(1000);
  } finally {
    await discovery.stop(true);
  }
});

test("Chromium discovery bounds response bytes before decoding JSON", async () => {
  const discovery = Bun.serve({ hostname: "127.0.0.1", port: 9222, fetch: () => new Response(Buffer.alloc(65537)) });
  try {
    await expect(
      connectChromium(
        () => {},
        () => {},
      ),
    ).rejects.toThrow("discovery");
  } finally {
    await discovery.stop(true);
  }
});
