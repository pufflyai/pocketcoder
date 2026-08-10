import { isScope } from "@pstdio/pocketcoder-contracts";
import { fail, valueList } from "../cli-context";

export function parseScopes(value: string) {
  const items = valueList(value);
  for (const item of items) if (!isScope(item)) fail(`unknown scope: ${item}`);
  return items;
}
