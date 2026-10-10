// A small USTAR subset: regular files and directories with fixed owner, mode and time.
// The reader accepts only headers this writer would produce, so archives stay canonical.
export const BLOCK = 512;
const OCTAL_SIZE_LIMIT = 8 ** 11;

export interface TarMember {
  path: string;
  type: "file" | "directory";
  size: number;
}

function put(header: Uint8Array, offset: number, length: number, value: string) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > length) throw new Error(`Backup member field is too long: ${value}`);
  header.set(bytes, offset);
}

function octal(value: number, length: number) {
  return `${value.toString(8).padStart(length - 1, "0")}\0`;
}

function splitPath(path: string) {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: "" };
  // USTAR stores long paths as prefix + "/" + name.
  for (let index = path.lastIndexOf("/"); index > 0; index = path.lastIndexOf("/", index - 1)) {
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100 && name) return { name, prefix };
  }
  throw new Error(`Backup member path is too long: ${path}`);
}

function putSize(header: Uint8Array, size: number) {
  if (size < OCTAL_SIZE_LIMIT) return put(header, 124, 12, octal(size, 12));
  // Base-256 size (GNU and POSIX readers accept it) for members of 8 GiB or more.
  header[124] = 0x80;
  let value = BigInt(size);
  for (let index = 135; index > 124; index--) {
    header[index] = Number(value & 0xffn);
    value >>= 8n;
  }
}

export function tarHeader({ path, type, size }: TarMember) {
  const header = new Uint8Array(BLOCK);
  const { name, prefix } = splitPath(type === "directory" ? `${path}/` : path);
  put(header, 0, 100, name);
  put(header, 100, 8, octal(type === "directory" ? 0o700 : 0o600, 8));
  put(header, 108, 8, octal(0, 8));
  put(header, 116, 8, octal(0, 8));
  putSize(header, type === "directory" ? 0 : size);
  put(header, 136, 12, octal(0, 12));
  header.fill(0x20, 148, 156);
  put(header, 156, 1, type === "directory" ? "5" : "0");
  put(header, 257, 6, "ustar\0");
  put(header, 263, 2, "00");
  put(header, 345, 155, prefix);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  put(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

function text(header: Uint8Array, offset: number, length: number) {
  const field = header.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return Buffer.from(end === -1 ? field : field.subarray(0, end)).toString("utf8");
}

function readSize(header: Uint8Array) {
  if (header[124] !== 0x80) return Number.parseInt(text(header, 124, 12), 8);
  let value = 0n;
  for (let index = 125; index < 136; index++) value = (value << 8n) | BigInt(header[index] ?? 0);
  return Number(value);
}

// Returns null for the zero block that ends the archive.
export function parseTarHeader(header: Uint8Array): TarMember | null {
  if (header.every((byte) => byte === 0)) return null;
  const type = text(header, 156, 1) === "5" ? "directory" : "file";
  const prefix = text(header, 345, 155);
  const name = text(header, 0, 100);
  const full = prefix ? `${prefix}/${name}` : name;
  const member = { path: type === "directory" ? full.slice(0, -1) : full, type, size: readSize(header) } as const;
  if (!Number.isSafeInteger(member.size) || !Buffer.from(tarHeader(member)).equals(Buffer.from(header)))
    throw new Error("Backup archive has a header this format does not produce.");
  return member;
}

export function tarPadding(size: number) {
  return (BLOCK - (size % BLOCK)) % BLOCK;
}
