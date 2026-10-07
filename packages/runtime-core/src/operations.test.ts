// Proves closed admission waits for actual detached descendants and retains failure.
import { expect, test } from "bun:test";
import { RuntimeOperations as ControllerOperations } from "./operations";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("closing admission joins a detached child after its parent returns", async () => {
  const owner = new ControllerOperations();
  const entered = deferred();
  const release = deferred();
  await owner.run(async () => {
    void owner.run(async () => {
      entered.resolve();
      await release.promise;
    });
  });
  await entered.promise;
  let closed = false;
  const closing = owner.close().then(() => {
    closed = true;
  });
  await expect(owner.run(async () => {})).rejects.toThrow("controller_admission_closed");
  await Bun.sleep(5);
  expect(closed).toBe(false);
  release.resolve();
  await closing;
  expect(closed).toBe(true);
});

test("admitted work may settle its child after closure while new work refuses", async () => {
  const owner = new ControllerOperations();
  const release = deferred();
  const entered = deferred();
  let childSettled = false;
  const parent = owner.run(async () => {
    entered.resolve();
    await release.promise;
    await owner.run(async () => {
      childSettled = true;
    });
  });
  await entered.promise;
  const closing = owner.close();
  release.resolve();
  await parent;
  await closing;
  expect(childSettled).toBe(true);
  await expect(owner.run(async () => {})).rejects.toThrow("controller_admission_closed");
});

test("failed admitted work cannot make closure succeed", async () => {
  const owner = new ControllerOperations();
  const release = deferred();
  const task = owner.run(async () => {
    await release.promise;
    throw new Error("original_mutation_failure");
  });
  const closing = owner.close();
  const taskObserved = task.then(
    () => null,
    (error) => error,
  );
  const closeObserved = closing.then(
    () => null,
    (error) => error,
  );
  release.resolve();
  expect(await taskObserved).toBeInstanceOf(Error);
  const closureFailure = await closeObserved;
  expect(closureFailure).toBeInstanceOf(AggregateError);
  expect(closureFailure.errors[0].message).toBe("original_mutation_failure");
  await expect(owner.close()).rejects.toThrow("controller_work_failed");
});

test("rejection settled before closure remains an owning failure", async () => {
  const owner = new ControllerOperations();
  const failure = new Error("settled_original_mutation_failure");
  const task = owner.run(async () => {
    throw failure;
  });
  await expect(task).rejects.toBe(failure);
  await Bun.sleep(0);
  await expect(owner.close()).rejects.toThrow("controller_work_failed");
  await expect(owner.close()).rejects.toThrow("controller_work_failed");
});
