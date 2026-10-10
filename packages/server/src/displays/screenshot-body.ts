import { crc32, inflateSync } from "node:zlib";
import { ApiError, SCREENSHOT_MAX_BYTES } from "@pstdio/pocketcoder-contracts";

export async function screenshotBody(request: Request, signal: AbortSignal) {
  if (request.headers.get("content-type") !== "image/png" || !request.body)
    throw new ApiError("validation.invalid", "Screenshot requires a PNG body.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let stop = () => {};
  const aborted = new Promise<never>((_, reject) => {
    stop = () => reject(new Error("Screenshot capture ended."));
  });
  signal.addEventListener("abort", stop, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await Promise.race([reader.read(), aborted]);
      if (chunk.done) break;
      length += chunk.value.length;
      if (length > SCREENSHOT_MAX_BYTES) throw new ApiError("relay.body_too_large", "Screenshot exceeds 4 MiB.");
      chunks.push(chunk.value);
    }
    signal.throwIfAborted();
    const bytes = Buffer.concat(chunks);
    validatePng(bytes);
    return bytes;
  } finally {
    signal.removeEventListener("abort", stop);
    reader.releaseLock();
  }
}

function pngFormat(bytes: Buffer) {
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) invalid();
  if (bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR") invalid();
  const width = bytes.readUInt32BE(16),
    height = bytes.readUInt32BE(20);
  if (width < 1 || height < 1 || width > 1920 || height > 1080) invalid();
  const color = bytes[25];
  if (bytes[24] !== 8 || (color !== 2 && color !== 6) || bytes[26] !== 0 || bytes[27] !== 0 || bytes[28] !== 0)
    invalid();
  return { width, height, channels: color === 2 ? 3 : 4 };
}

export function validatePng(bytes: Buffer) {
  const { width, height, channels } = pngFormat(bytes);
  const images: Buffer[] = [];
  let offset = 8,
    image = false;
  while (offset + 12 <= bytes.length) {
    const size = bytes.readUInt32BE(offset),
      end = offset + 12 + size;
    if (end > bytes.length) invalid();
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) invalid();
    if (type === "IDAT") {
      image = true;
      images.push(bytes.subarray(offset + 8, end - 4));
    }
    if (type === "IEND") {
      if (size !== 0 || end !== bytes.length || !image) invalid();
      validatePixels(Buffer.concat(images), width, height, channels);
      return;
    }
    offset = end;
  }
  invalid();
}

function validatePixels(compressed: Buffer, width: number, height: number, channels: number) {
  const rowBytes = width * channels + 1;
  const expected = rowBytes * height;
  let pixels: Buffer;
  try {
    pixels = inflateSync(compressed, { maxOutputLength: expected });
  } catch {
    throw new ApiError("validation.invalid", "Invalid PNG pixel data.");
  }
  if (pixels.length !== expected) throw new ApiError("validation.invalid", "Incomplete PNG pixel data.");
  for (let row = 0; row < height; row++) {
    if ((pixels[row * rowBytes] ?? 255) > 4) throw new ApiError("validation.invalid", "Invalid PNG row filter.");
  }
}

function invalid() {
  throw new ApiError("validation.invalid", "Invalid or oversized PNG dimensions.");
}
