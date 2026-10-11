import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { type FileHandle, open as openFile, rm } from "node:fs/promises";

const magic = Buffer.from("PC-OFFNODE-01");
const nonceBytes = 12;
const tagBytes = 16;
const headerBytes = magic.length + nonceBytes;

function cipher(key: Uint8Array, nonce: Uint8Array, context: string) {
  const encrypt = createCipheriv("aes-256-gcm", key, nonce);
  encrypt.setAAD(Buffer.from(context));
  return encrypt;
}

function decipher(header: Buffer, key: Uint8Array, tag: Uint8Array, context: string) {
  if (!header.subarray(0, magic.length).equals(magic)) throw new Error("Invalid off-node encryption format.");
  const decrypt = createDecipheriv("aes-256-gcm", key, header.subarray(magic.length));
  decrypt.setAAD(Buffer.from(context));
  decrypt.setAuthTag(tag);
  return decrypt;
}

export function seal(bytes: Uint8Array, key: Uint8Array, context: string) {
  const nonce = randomBytes(nonceBytes);
  const encrypt = cipher(key, nonce, context);
  return Buffer.concat([magic, nonce, encrypt.update(bytes), encrypt.final(), encrypt.getAuthTag()]);
}

export function open(bytes: Uint8Array, key: Uint8Array, context: string) {
  const value = Buffer.from(bytes);
  if (value.length < headerBytes + tagBytes) throw new Error("Incomplete off-node object.");
  const decrypt = decipher(value.subarray(0, headerBytes), key, value.subarray(-tagBytes), context);
  return Buffer.concat([decrypt.update(value.subarray(headerBytes, -tagBytes)), decrypt.final()]);
}

async function write(target: FileHandle, bytes: Buffer) {
  for (let done = 0; done < bytes.length; ) {
    done += (await target.write(bytes, done, bytes.length - done)).bytesWritten;
  }
}

export async function encryptFile(source: string, output: string, key: Uint8Array, context: string) {
  const nonce = randomBytes(nonceBytes);
  const encrypt = cipher(key, nonce, context);
  const target = await openFile(output, "wx", 0o600);
  try {
    await write(target, Buffer.concat([magic, nonce]));
    for await (const chunk of createReadStream(source)) await write(target, encrypt.update(chunk));
    await write(target, encrypt.final());
    await write(target, encrypt.getAuthTag());
    await target.sync();
  } catch (error) {
    await rm(output, { force: true });
    throw error;
  } finally {
    await target.close();
  }
}

export async function decryptFile(source: string, output: string, key: Uint8Array, context: string) {
  const input = await openFile(source, "r");
  let target: FileHandle | undefined;
  try {
    const { size } = await input.stat();
    if (size < headerBytes + tagBytes) throw new Error("Incomplete off-node object.");
    const header = Buffer.alloc(headerBytes);
    const tag = Buffer.alloc(tagBytes);
    await input.read(header, 0, header.length, 0);
    await input.read(tag, 0, tag.length, size - tagBytes);
    const decrypt = decipher(header, key, tag, context);
    target = await openFile(output, "wx", 0o600);
    const chunk = Buffer.alloc(1024 ** 2);
    for (let offset = headerBytes; offset < size - tagBytes; ) {
      const length = Math.min(chunk.length, size - tagBytes - offset);
      const { bytesRead } = await input.read(chunk, 0, length, offset);
      if (!bytesRead) throw new Error("Incomplete off-node object.");
      await write(target, decrypt.update(chunk.subarray(0, bytesRead)));
      offset += bytesRead;
    }
    await write(target, decrypt.final());
    await target.sync();
  } catch (error) {
    if (target) await rm(output, { force: true });
    throw error;
  } finally {
    await target?.close();
    await input.close();
  }
}
