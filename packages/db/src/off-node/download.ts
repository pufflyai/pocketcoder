import { open, rm } from "node:fs/promises";

export async function downloadFile(response: Response, output: string, maximum?: number) {
  if (!response.body) throw new Error("Off-node backup body is missing.");
  const target = await open(output, "wx", 0o600);
  try {
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (maximum !== undefined && bytes > maximum) throw new Error("Off-node object exceeds its admitted capacity.");
      for (let offset = 0; offset < chunk.length; )
        offset += (await target.write(chunk, offset, chunk.length - offset)).bytesWritten;
    }
    await target.sync();
  } catch (error) {
    await rm(output, { force: true });
    throw error;
  } finally {
    await target.close();
  }
}
