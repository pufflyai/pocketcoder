import { randomUUID } from "node:crypto";
import { waitFor } from "./local-process";
import { managedDiagnostics } from "./managed-diagnostics";
import { managedLifecycleFixture } from "./managed-lifecycle-fixture";
import { upgradeData } from "./managed-upgrade-data";
import { upgradeImages } from "./managed-upgrade-images";
import { upgradeObserver } from "./managed-upgrade-observer";
import { offNodeFixture } from "./off-node-fixture";

type Fixture = Awaited<ReturnType<typeof managedLifecycleFixture>>;
type Operation = { id: string; state: string; phase: string; errorCode: string | null; upgrade: { mode: string } };
const storage = await offNodeFixture();
let fixture: Fixture | undefined;
let images: Awaited<ReturnType<typeof upgradeImages>> | undefined;
let cluster: Fixture["cluster"] | undefined;
let fault: { namespace: string; name: string } | undefined;
let currentAccount: { id: string; namespace: string } | undefined;
let currentOperation: string | undefined;
let failure: unknown;
let queuedRecovery: (() => void) | undefined;
try {
  fixture = await managedLifecycleFixture(storage.configure, {
    async configureReleases(ownedCluster, source) {
      cluster = ownedCluster;
      images = await upgradeImages(ownedCluster, source);
      return images.releases;
    },
    async command(args, input) {
      if (!cluster) throw new Error("Upgrade cluster is missing.");
      if (fault && args.includes(fault.namespace) && args.includes("rollout")) {
        const expected = fault;
        await waitFor(
          async () => {
            try {
              const result = JSON.parse(
                (await cluster?.kube([
                  "-n",
                  expected.namespace,
                  "exec",
                  "deployment/controller",
                  "-c",
                  "controller",
                  "--",
                  "bun",
                  "-e",
                  "console.log(JSON.stringify(await Bun.file('/private/upgrade-demo-fault.json').json()))",
                ])) ?? "null",
              );
              return result?.name === expected.name;
            } catch {
              return false;
            }
          },
          60_000,
          `real fault after ${expected.name}`,
        );
        fault = undefined;
        queuedRecovery?.();
        queuedRecovery = undefined;
        throw new Error(`Injected failure after ${expected.name}.`);
      }
      try {
        return await cluster.kube(args, input);
      } catch (error) {
        console.error(JSON.stringify({ upgradeCommandFailure: { command: args.slice(0, 6), error: String(error) } }));
        throw error;
      }
    },
  });
  const f = fixture;
  async function post(path: string, body: unknown, requestId = randomUUID()) {
    const response = await f.request(path, {
      method: "POST",
      headers: { "idempotency-key": requestId },
      body: JSON.stringify(body),
    });
    if (response.status !== 202)
      throw new Error(`Upgrade admission failed ${path}: ${response.status} ${await response.text()}`);
    return (await response.json()) as { account: { id: string; namespace: string }; operation: Operation };
  }
  async function operation(id: string) {
    return (await (await f.request(`/v1/operations/${id}`)).json()) as Operation;
  }
  async function finish(id: string) {
    let previous: string | undefined;
    await waitFor(
      async () => {
        await f.reconcile();
        const current = await operation(id);
        const progress = JSON.stringify({ id, phase: current.phase, state: current.state, error: current.errorCode });
        if (progress !== previous) console.log(JSON.stringify({ upgradeProgress: JSON.parse(progress) }));
        previous = progress;
        return current.state === "succeeded";
      },
      180_000,
      "restartable account upgrade",
    );
  }
  const accounts = [];
  for (const name of ["rollback", "forward-fix", "restore", "other"])
    accounts.push((await post("/v1/accounts", { name })).account);
  await f.reconcile();
  const other = accounts[3];
  if (!other) throw new Error("Observer account is missing.");
  const observeOther = await upgradeObserver(f, other);
  for (const [index, scenario, version, action] of [
    [0, "compatible", "1.0.0-rc.2", "rollback"],
    [1, "migration", "1.0.0-rc.3", "forward_fix"],
    [2, "write", "1.0.0-rc.5", "restore"],
  ] as const) {
    const account = accounts[index];
    if (!account) throw new Error("Upgrade account fixture is missing.");
    currentAccount = account;
    const data = await upgradeData(f, account);
    if (action === "restore")
      await f.cluster.kube([
        "-n",
        account.namespace,
        "exec",
        "deployment/controller",
        "-c",
        "controller",
        "--",
        "bun",
        "-e",
        "await Bun.write('/private/upgrade-demo-revoke.json',process.argv[1])",
        JSON.stringify({ keyId: data.keyId }),
      ]);
    fault = { namespace: account.namespace, name: scenario };
    const requestId = randomUUID();
    const admitted = await post(`/v1/accounts/${account.id}/upgrade`, { version }, requestId);
    const id = admitted.operation.id;
    currentOperation = id;
    let recoveryInFlight: Promise<unknown> | undefined;
    if (action === "rollback")
      queuedRecovery = () => {
        recoveryInFlight = f
          .currentService()
          ?.recoverUpgrade(
            account.id,
            id,
            "rollback",
            undefined,
            images?.releases ?? [],
            new Date(Date.now() + 60_000),
          );
        recoveryInFlight?.catch(() => {});
      };
    await f.reconcile();
    await recoveryInFlight;
    const failed = await operation(id);
    if (!recoveryInFlight && (failed.phase !== "install" || failed.errorCode !== "upgrade_retry"))
      throw new Error(`Fault did not stop the upgrade: ${JSON.stringify(failed)}`);
    const lifecycle = JSON.parse(
      await f.cluster.kube([
        "-n",
        account.namespace,
        "exec",
        "deployment/controller",
        "-c",
        "controller",
        "--",
        "bun",
        "-e",
        "console.log(await Bun.file('/private/pc_data/account-lifecycle.json').text())",
      ]),
    );
    if (lifecycle.state !== "suspended") throw new Error("Failed upgrade lost its admission fence.");
    const backups = await f.currentStore()?.listBackups(account.id);
    if (backups?.length !== 1 || backups[0]?.id !== id)
      throw new Error("Upgrade has no single verified pre-mutation backup.");
    const versions = await storage.storage.storage.versions(`accounts/${account.id}/backups/`);
    await observeOther();
    await f.restartManager();
    if ((await post(`/v1/accounts/${account.id}/upgrade`, { version }, requestId)).operation.id !== id)
      throw new Error("Upgrade restart changed operation identity.");
    if (action !== "rollback") {
      const refused = await f.request(`/v1/accounts/${account.id}/upgrade-recovery`, {
        method: "POST",
        body: JSON.stringify({ operation_id: id, action: "rollback" }),
      });
      if (refused.status !== 409) throw new Error("A migrated format allowed image rollback.");
    }
    const recovery = { operation_id: id, action, ...(action === "forward_fix" ? { version: "1.0.0-rc.4" } : {}) };
    await post(`/v1/accounts/${account.id}/upgrade-recovery`, recovery);
    await f.restartManager();
    await finish(id);
    if (
      JSON.stringify(await storage.storage.storage.versions(`accounts/${account.id}/backups/`)) !==
      JSON.stringify(versions)
    )
      throw new Error("Upgrade recovery captured its backup again.");
    await data.verify(action === "restore");
    await observeOther();
    const firstWrite = await data.firstWritePresent();
    if (firstWrite !== (action === "rollback")) throw new Error("Upgrade recovery first-write boundary differs.");
    console.log(
      JSON.stringify({
        upgradeRecoveryPassed: {
          account: account.id,
          operation: id,
          fault: scenario,
          recovery: action,
          firstWrite,
          backupVersions: versions.length,
        },
      }),
    );
    if (action === "restore") {
      const refused = await f.request(`/v1/accounts/${account.id}/upgrade`, {
        method: "POST",
        headers: { "idempotency-key": randomUUID() },
        body: JSON.stringify({ version: "1.0.0-rc.2" }),
      });
      const result = (await refused.json()) as { code: string };
      if (refused.status !== 409 || result.code !== "upgrade_recovery_capacity")
        throw new Error("Upgrade admitted without a fresh restore slot.");
      if ((await f.currentStore()?.getAccount(account.id))?.state !== "ready")
        throw new Error("Restore capacity refusal mutated the account.");
    }
  }
  console.log(
    JSON.stringify({ managedUpgradePassed: true, environment: "owned local Kind and RustFS", hostedAcceptance: false }),
  );
} catch (error) {
  failure = error;
  if (fixture && currentAccount) await managedDiagnostics(fixture, currentAccount.namespace, currentOperation);
} finally {
  await images?.close();
  await fixture?.close();
  await storage.close();
}
if (failure) throw failure;
