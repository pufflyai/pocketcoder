import { ProviderBootstrapInputSchema, type ProviderInput } from "@pstdio/pocketcoder-contracts";
import { waitForPoolLease } from "./pool-lease";

export async function loadProviderInput(inputPath: string): Promise<ProviderInput> {
  const raw = await Bun.file(inputPath).text();
  const bootstrap = ProviderBootstrapInputSchema.parse(JSON.parse(raw));
  return "pool_runtime_id" in bootstrap ? await waitForPoolLease(bootstrap) : bootstrap;
}
