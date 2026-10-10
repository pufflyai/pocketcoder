import { type Browser, type BrowserContext, chromium, firefox } from "playwright";

async function inspect(context: BrowserContext, parent: string, screenshot: string) {
  const page = await context.newPage();
  await page.goto(parent);
  const frame = page.frameLocator("#view");
  await frame.locator("body").waitFor();
  await page.waitForFunction(() => {
    const iframe = document.querySelector<HTMLIFrameElement>("#view");
    return iframe?.src.includes("/.pc/open");
  });
  const supported = await frame
    .locator("#browser-screen")
    .waitFor({ timeout: 10_000 })
    .then(
      () => true,
      () => false,
    );
  if (supported) {
    const view = page.frames().find((candidate) => candidate.url().includes("-display."));
    if (!view) throw new Error("Embedded viewer frame is missing.");
    await view.waitForFunction(
      () => (document.querySelector("#browser-screen") as HTMLImageElement)?.naturalWidth > 0,
      undefined,
      { timeout: 10_000 },
    );
  } else await page.getByText("Cookies blocked: Open in a new tab", { exact: true }).waitFor();
  await page.screenshot({ path: screenshot });
  const popup = page.waitForEvent("popup");
  await page.locator("#open").click();
  const top = await popup;
  await top.waitForURL(/-display\./);
  try {
    await top.locator("#browser-screen").waitFor();
  } catch (error) {
    console.log("Top-level failure", new URL(top.url()).pathname, await top.locator("body").innerText());
    await top.screenshot({ path: screenshot.replace(".png", "-top-failed.png") });
    throw error;
  }
  await top.waitForFunction(() => (document.querySelector("#browser-screen") as HTMLImageElement)?.naturalWidth > 0);
  if (new URL(top.url()).search) throw new Error("The top-level view kept its token.");
  await top.close();
  await page.close();
  return supported ? "partitioned-view-works" : "explicit-fallback";
}

async function run(browser: Browser, name: string, parent: string, directory: string) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    return {
      browser: name,
      cookies: "third-party-blocked",
      embedded: await inspect(context, parent, `${directory}/${name}.png`),
      topLevel: "works",
    };
  } finally {
    await context.close();
    await browser.close();
  }
}

export async function checkEmbedBrowsers(parent: string, directory: string) {
  const chrome = await chromium.launch({ args: ["--test-third-party-cookie-phaseout"] });
  const results = [await run(chrome, "chromium", parent, directory)];
  const fox = await firefox.launch({ firefoxUserPrefs: { "network.cookie.cookieBehavior": 1 } });
  results.push(await run(fox, "firefox", parent, directory));
  return results;
}
