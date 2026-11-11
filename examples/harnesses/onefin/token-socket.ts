import { chmod, rm } from "node:fs/promises";
import { createServer } from "node:net";

export async function tokenSocket(path: string, accessToken: () => Promise<string>) {
  await rm(path, { force: true });
  const server = createServer((socket) => {
    void accessToken().then(
      (token) => socket.end(token),
      () => socket.destroy(),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
  await chmod(path, 0o600);
  return {
    async close() {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await rm(path, { force: true });
    },
  };
}
