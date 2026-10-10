import { PREVIEW_FRAME_BYTES } from "../previews/limits";

export const BROWSER_IMAGE_BYTES = 4 * 1024 * 1024;
const HEADER_BYTES = 8;
export function* browserFrameChunks(image: Uint8Array) {
  if (!image.length || image.length > BROWSER_IMAGE_BYTES) throw new Error("Browser image exceeds its budget.");
  const size = PREVIEW_FRAME_BYTES - HEADER_BYTES;
  for (let offset = 0; offset < image.length; offset += size) {
    const content = image.subarray(offset, offset + size);
    const chunk = new Uint8Array(HEADER_BYTES + content.length);
    const header = new DataView(chunk.buffer);
    header.setUint32(0, image.length);
    header.setUint32(4, offset);
    chunk.set(content, HEADER_BYTES);
    yield chunk;
  }
}

export class BrowserFrames {
  private image: Uint8Array | undefined;
  private offset = 0;

  receive(chunk: Uint8Array) {
    if (chunk.length <= HEADER_BYTES || chunk.length > PREVIEW_FRAME_BYTES) throw new Error("Invalid browser chunk.");
    const header = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const total = header.getUint32(0),
      offset = header.getUint32(4);
    if (!total || total > BROWSER_IMAGE_BYTES || offset !== this.offset)
      throw new Error("Invalid browser image bounds.");
    if (!this.image) this.image = new Uint8Array(total);
    if (total !== this.image.length || offset + chunk.length - HEADER_BYTES > total)
      throw new Error("Invalid browser image sequence.");
    this.image.set(chunk.subarray(HEADER_BYTES), offset);
    this.offset += chunk.length - HEADER_BYTES;
    if (this.offset !== total) return;
    const completed = this.image;
    this.image = undefined;
    this.offset = 0;
    return completed;
  }
}
