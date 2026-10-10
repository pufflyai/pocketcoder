import { randomBytes } from "node:crypto";
import { createConnection } from "node:net";

export async function pauseBrowser(baseUrl: string, origin: URL, cookie: string) {
  const base = new URL(baseUrl);
  const socket = createConnection({ host: base.hostname, port: Number(base.port) });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Paused viewer did not connect."));
    }, 5000);
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.write(
        `GET /socket HTTP/1.1\r\nHost: ${origin.host}\r\nOrigin: ${origin.origin}\r\nCookie: ${cookie}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\n\r\n`,
      );
    });
    let headers = "";
    socket.on("data", function upgrade(bytes) {
      headers += bytes.toString("latin1");
      if (!headers.includes("\r\n\r\n")) return;
      clearTimeout(timer);
      socket.removeListener("data", upgrade);
      if (!headers.startsWith("HTTP/1.1 101 ")) {
        socket.destroy();
        reject(new Error("Paused viewer was rejected."));
        return;
      }
      socket.pause();
      resolve();
    });
  });
  return socket;
}
