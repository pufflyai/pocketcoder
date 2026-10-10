import { accountService, createManagerApp } from "./app";
import { ManagerConfigSchema } from "./config";
import { ManagerStore } from "./database/store";

const store = await ManagerStore.create(process.env.POCKETCODER_MANAGER_DIR ?? "./manager_data");
if (process.argv[2] === "operator") {
  try {
    const expiry = process.argv[3];
    if (!expiry) throw new Error("Provide an explicit ISO operator expiry, at most 24 hours");
    console.log(JSON.stringify({ token: await store.createOperator(new Date(expiry)), expires_at: expiry }));
  } finally {
    await store.close();
  }
} else {
  const config = ManagerConfigSchema.parse({
    controllerImage: process.env.POCKETCODER_MANAGER_CONTROLLER_IMAGE,
    runtimeClassName: process.env.POCKETCODER_MANAGER_RUNTIME_CLASS,
    ...(process.env.POCKETCODER_MANAGER_STORAGE_CLASS
      ? { storageClassName: process.env.POCKETCODER_MANAGER_STORAGE_CLASS }
      : {}),
  });
  const service = accountService(store);
  const app = createManagerApp(store, config, service);
  const endpoint = new URL(`http://${process.env.POCKETCODER_MANAGER_HTTP ?? "127.0.0.1:8092"}`);
  const server = Bun.serve({
    hostname: endpoint.hostname,
    port: Number(endpoint.port),
    maxRequestBodySize: 8192,
    fetch: app.fetch,
  });
  const timer = setInterval(() => {
    void service.reconcile().catch(() => console.error("Manager reconciliation failed"));
  }, 2000);
  void service.reconcile().catch(() => console.error("Manager reconciliation failed"));
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    clearInterval(timer);
    await server.stop(true);
    await service.close();
    await store.close();
    process.exit(0);
  };
  process.on("SIGTERM", close);
  process.on("SIGINT", close);
  console.log(`Manager listening at ${server.url}`);
}
