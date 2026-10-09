export function checkpointTarHeader(name: string, size: number) {
  if (
    !/^[a-z0-9./]+$/.test(name) ||
    name.length > 100 ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    size > 0o77777777777
  )
    throw new Error("Invalid checkpoint tar header.");
  const value = Buffer.alloc(512);
  value.write(name);
  for (const [offset, width, number] of [
    [100, 8, 0o600],
    [108, 8, 0],
    [116, 8, 0],
    [124, 12, size],
    [136, 12, 0],
  ] as const)
    value.write(`${number.toString(8).padStart(width - 1, "0")}\0`, offset, width);
  value.fill(32, 148, 156);
  value.write("0", 156);
  value.write("ustar\0", 257);
  value.write("00", 263);
  const checksum = value.reduce((sum, byte) => sum + byte, 0);
  value.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return value;
}

export function parseCheckpointTarHeader(bytes: Buffer) {
  const end = bytes.subarray(0, 100).indexOf(0);
  const name = bytes.toString("ascii", 0, end < 0 ? 100 : end);
  const sizeText = bytes.toString("ascii", 124, 136);
  if (!/^[0-7]{11}\0$/.test(sizeText)) throw new Error("Invalid checkpoint tar header size.");
  const size = Number.parseInt(sizeText, 8);
  if (!checkpointTarHeader(name, size).equals(bytes)) throw new Error("Invalid checkpoint tar header.");
  return { name, size };
}
