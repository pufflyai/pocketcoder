import { createConnection, type Socket } from "node:net";
import { encodePng } from "./png";

class RfbReader {
  private bytes = Buffer.alloc(0);
  private notify = () => {};
  private error: Error | null = null;
  constructor(socket: Socket, signal: AbortSignal) {
    socket.on("data", (bytes) => {
      if (typeof bytes === "string") throw new Error("RFB requires binary data.");
      if (this.bytes.length + bytes.length > 1920 * 1080 * 4 + 65536) {
        socket.destroy(new Error("Desktop response exceeds capture limit."));
        return;
      }
      this.bytes = Buffer.concat([this.bytes, bytes]);
      this.notify();
    });
    socket.on("error", (error) => {
      this.error = error;
      this.notify();
    });
    socket.on("close", () => {
      this.error ??= new Error("Desktop closed during capture.");
      this.notify();
    });
    const abort = () => socket.destroy(new Error("Desktop capture ended."));
    signal.addEventListener("abort", abort, { once: true });
    socket.once("close", () => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  }
  async read(size: number) {
    while (this.bytes.length < size) {
      if (this.error) throw this.error;
      await new Promise<void>((resolve) => {
        this.notify = resolve;
      });
    }
    const bytes = this.bytes.subarray(0, size);
    this.bytes = this.bytes.subarray(size);
    return bytes;
  }
}

export async function captureDesktop(signal: AbortSignal) {
  signal.throwIfAborted();
  const socket = createConnection({ host: "127.0.0.1", port: 5900 });
  const reader = new RfbReader(socket, signal);
  try {
    if ((await reader.read(12)).toString() !== "RFB 003.008\n") throw new Error("Unsupported desktop protocol.");
    socket.write("RFB 003.008\n");
    const count = (await reader.read(1))[0] ?? 0;
    if (!count || !(await reader.read(count)).includes(1)) throw new Error("Unsupported desktop security.");
    socket.write(Buffer.from([1]));
    if ((await reader.read(4)).readUInt32BE() !== 0) throw new Error("Desktop security failed.");
    socket.write(Buffer.from([1]));
    const init = await reader.read(24);
    const width = init.readUInt16BE(),
      height = init.readUInt16BE(2);
    if (width < 1 || height < 1 || width > 1920 || height > 1080 || init.readUInt32BE(20) > 65536)
      throw new Error("Desktop dimensions exceed capture limit.");
    await reader.read(init.readUInt32BE(20));
    // Request only raw, little-endian true-color pixels; no workspace-selected codec runs here.
    const format = Buffer.alloc(20);
    format.set([32, 24, 0, 1], 4);
    for (const offset of [8, 10, 12]) format.writeUInt16BE(255, offset);
    format.set([16, 8, 0], 14);
    socket.write(format);
    socket.write(Buffer.from([2, 0, 0, 1, 0, 0, 0, 0]));
    const request = Buffer.alloc(10);
    request[0] = 3;
    request.writeUInt16BE(width, 6);
    request.writeUInt16BE(height, 8);
    socket.write(request);
    const rgb = await readFramebuffer(reader, width, height);
    signal.throwIfAborted();
    return encodePng(width, height, rgb);
  } finally {
    socket.destroy();
  }
}

async function readFramebuffer(reader: RfbReader, width: number, height: number) {
  const rgb = Buffer.alloc(width * height * 3);
  const update = await reader.read(4);
  if (update[0] !== 0) throw new Error("Expected desktop framebuffer update.");
  const rectangles = update.readUInt16BE(2);
  if (!rectangles || rectangles > 4096) throw new Error("Desktop rectangle limit exceeded.");
  let covered = 0;
  for (let n = 0; n < rectangles; n++) {
    const rect = await reader.read(12);
    const x = rect.readUInt16BE(),
      y = rect.readUInt16BE(2),
      w = rect.readUInt16BE(4),
      h = rect.readUInt16BE(6);
    if (rect.readInt32BE(8) !== 0 || x + w > width || y + h > height) throw new Error("Invalid desktop rectangle.");
    covered += w * h;
    if (covered > width * height) throw new Error("Desktop pixel limit exceeded.");
    const pixels = await reader.read(w * h * 4);
    for (let row = 0; row < h; row++)
      for (let col = 0; col < w; col++) {
        const source = (row * w + col) * 4,
          destination = ((y + row) * width + x + col) * 3;
        rgb[destination] = pixels[source + 2] ?? 0;
        rgb[destination + 1] = pixels[source + 1] ?? 0;
        rgb[destination + 2] = pixels[source] ?? 0;
      }
  }
  if (covered !== width * height) throw new Error("Desktop capture is incomplete.");
  return rgb;
}
