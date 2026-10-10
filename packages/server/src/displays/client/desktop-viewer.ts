import RFB from "@novnc/novnc";

const screen = document.querySelector<HTMLElement>("#screen");
const status = document.querySelector<HTMLElement>("#status");
if (!screen || !status) throw new Error("Missing desktop viewer elements.");
const url = new URL("/socket", location.href);
url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
const rfb = new RFB(screen, url.href, { shared: true });
rfb.viewOnly = document.body.dataset.control !== "true";
rfb.scaleViewport = true;
rfb.resizeSession = false;
rfb.addEventListener("connect", () => {
  status.textContent = rfb.viewOnly ? "View only" : "Control active";
});
rfb.addEventListener("disconnect", () => {
  status.textContent = "Disconnected. Open a fresh display session to reconnect.";
});
