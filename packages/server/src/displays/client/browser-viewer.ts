import { BrowserFrames } from "@pstdio/pocketcoder-contracts/browser-display";

const status = document.querySelector<HTMLElement>("#status");
const screen = document.querySelector<HTMLImageElement>("#browser-screen");
const controls = document.querySelector<HTMLFormElement>("#navigation");
const address = document.querySelector<HTMLInputElement>("#address");
if (!status || !screen || !controls || !address) throw new Error("Browser viewer elements are missing.");
const control = document.body.dataset.control === "true";
const url = new URL("/socket", location.href);
url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
const socket = new WebSocket(url);
socket.binaryType = "arraybuffer";
let imageUrl: string | undefined;
const frames = new BrowserFrames();
socket.onopen = () => {
  status.textContent = control ? "Control active" : "View only";
};
socket.onclose = () => {
  status.textContent = "Disconnected";
};
socket.onerror = () => {
  status.textContent = "Connection failed";
};
socket.onmessage = (event) => {
  const frame = frames.receive(new Uint8Array(event.data as ArrayBuffer));
  if (!frame) return;
  const next = URL.createObjectURL(new Blob([frame.slice().buffer], { type: "image/jpeg" }));
  screen.src = next;
  if (imageUrl) URL.revokeObjectURL(imageUrl);
  imageUrl = next;
};
function send(action: unknown) {
  if (control && socket.readyState === WebSocket.OPEN) socket.send(new TextEncoder().encode(JSON.stringify(action)));
}
controls.hidden = !control;
controls.onsubmit = (event) => {
  event.preventDefault();
  send({ action: "navigate", url: address.value });
  screen.focus();
};
const point = (event: MouseEvent) => {
  const rect = screen.getBoundingClientRect();
  return {
    x: Math.min(1279, Math.max(0, Math.floor(((event.clientX - rect.left) * 1280) / rect.width))),
    y: Math.min(799, Math.max(0, Math.floor(((event.clientY - rect.top) * 800) / rect.height))),
  };
};
screen.onclick = (event) => {
  screen.focus();
  send({ action: "click", ...point(event) });
};
screen.onwheel = (event) => {
  if (!control) return;
  event.preventDefault();
  send({ action: "scroll", ...point(event), deltaY: Math.round(Math.max(-1000, Math.min(1000, event.deltaY))) });
};
screen.onkeydown = (event) => {
  if (!control || event.ctrlKey || event.metaKey || event.altKey) return;
  event.preventDefault();
  if (event.key.length === 1) send({ action: "text", text: event.key });
  else if (
    [
      "Enter",
      "Tab",
      "Backspace",
      "Delete",
      "Escape",
      "ArrowLeft",
      "ArrowRight",
      "ArrowUp",
      "ArrowDown",
      "Home",
      "End",
      "PageUp",
      "PageDown",
    ].includes(event.key)
  )
    send({ action: "key", key: event.key });
};
