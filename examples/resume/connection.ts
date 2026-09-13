import { join } from "node:path";

export interface Connection {
  baseUrl: string;
  key: string;
  controlUrl: string;
  controlKey: string;
  expiresAt: string;
}

export function connectionFile(directory: string) {
  return join(directory, "connection.json");
}

export async function readConnection(directory: string) {
  const file = Bun.file(connectionFile(directory));
  return (await file.exists()) ? ((await file.json()) as Connection) : undefined;
}

export async function sessionControl(connection: Connection, action: string) {
  const response = await fetch(`${connection.controlUrl}/${action}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${connection.controlKey}`,
      "content-type": "application/json",
    },
    body: "{}",
  });
  if (!response.ok) throw new Error(await response.text());
  return response;
}
