import { createHash } from "node:crypto";

export async function connectDesktop(baseUrl: string, origin: URL, cookie: string) {
  const socket = new WebSocket(`${baseUrl.replace("http", "ws")}/socket`, {
    headers: { host: origin.host, origin: origin.origin, cookie },
  } as unknown as string[]);
  socket.binaryType = "arraybuffer";
  let bytes = Buffer.alloc(0);
  let wake: (() => void) | undefined;
  let ended = false;
  socket.onmessage = (event) => {
    bytes = Buffer.concat([bytes, Buffer.from(event.data as ArrayBuffer)]);
    if (bytes.length > 8 * 1024 * 1024) socket.close();
    wake?.();
  };
  const closed = new Promise<void>((resolve) => {
    socket.onclose = () => {
      ended = true;
      wake?.();
      resolve();
    };
  });
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error("Desktop socket rejected."));
  });
  async function read(length: number) {
    while (bytes.length < length) {
      if (ended) throw new Error("Desktop ended before completing its response.");
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Desktop response deadline exceeded.")), 10_000);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
    const result = bytes.subarray(0, length);
    bytes = bytes.subarray(length);
    return result;
  }
  if ((await read(12)).toString() !== "RFB 003.008\n") throw new Error("Unexpected desktop protocol.");
  socket.send(Buffer.from("RFB 003.008\n"));
  const count = (await read(1))[0] ?? 0;
  if (!(await read(count)).includes(1)) throw new Error("Desktop offered unexpected authentication.");
  socket.send(new Uint8Array([1]));
  if ((await read(4)).readUInt32BE() !== 0) throw new Error("Desktop handshake failed.");
  socket.send(new Uint8Array([1]));
  const init = await read(24);
  const width = init.readUInt16BE(0),
    height = init.readUInt16BE(2);
  const bytesPerPixel = (init[4] ?? 0) / 8;
  await read(init.readUInt32BE(20));
  socket.send(new Uint8Array([2, 0, 0, 1, 0, 0, 0, 0]));
  async function capture() {
    const request = Buffer.alloc(10);
    request[0] = 3;
    request.writeUInt16BE(width, 6);
    request.writeUInt16BE(height, 8);
    socket.send(request);
    const header = await read(4);
    if (header[0] !== 0) throw new Error("Unexpected desktop response.");
    const hash = createHash("sha256");
    const values = new Set<number>();
    for (let index = 0; index < header.readUInt16BE(2); index++) {
      const rect = await read(12);
      if (rect.readInt32BE(8) !== 0) throw new Error("Desktop did not use requested raw pixels.");
      const pixels = await read(rect.readUInt16BE(4) * rect.readUInt16BE(6) * bytesPerPixel);
      hash.update(pixels);
      for (let offset = 0; offset < pixels.length; offset += bytesPerPixel) values.add(pixels.readUInt32LE(offset));
    }
    if (values.size < 3)
      throw new Error(
        `Desktop is blank: ${values.size} colors, ${header.readUInt16BE(2)} rectangles, ${width}x${height}, ${bytesPerPixel} bytes/pixel.`,
      );
    return hash.digest("hex");
  }
  function key(value: number, down: boolean) {
    const message = Buffer.alloc(8);
    message[0] = 4;
    message[1] = Number(down);
    message.writeUInt32BE(value, 4);
    socket.send(message);
  }
  function type(text: string) {
    for (const character of text) {
      key(character.codePointAt(0) ?? 0, true);
      key(character.codePointAt(0) ?? 0, false);
    }
    key(0xff0d, true);
    key(0xff0d, false);
  }
  function click(x: number, y: number) {
    for (const mask of [0, 1, 0]) {
      const message = Buffer.alloc(6);
      message[0] = 5;
      message[1] = mask;
      message.writeUInt16BE(x, 2);
      message.writeUInt16BE(y, 4);
      socket.send(message);
    }
  }
  return { socket, closed, capture, type, click };
}
