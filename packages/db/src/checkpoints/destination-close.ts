import { closeSync, fstatSync } from "node:fs";
import { destinationCustody } from "./destination-custody";

export function closeDestinationDescriptor(descriptor: number, expected: Buffer) {
  const current = destinationCustody(fstatSync(descriptor, { bigint: true }));
  if (!current.subarray(0, 16).equals(expected.subarray(0, 16)))
    throw new Error("Checkpoint destination descriptor was reused.");
  closeSync(descriptor);
}
export async function drainDestinationClose(
  active: () => { close(): Promise<void> } | undefined,
  pending: () => Promise<unknown> | undefined,
  remove: () => Promise<void>,
  release: () => Promise<void>,
) {
  const errors: unknown[] = [];
  try {
    await active()?.close();
  } catch (error) {
    errors.push(error);
  }
  await pending()?.catch(() => {});
  try {
    await active()?.close();
  } catch (error) {
    errors.push(error);
  }
  try {
    await remove();
  } catch (error) {
    errors.push(error);
  }
  try {
    await release();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length) throw errors[0];
}
