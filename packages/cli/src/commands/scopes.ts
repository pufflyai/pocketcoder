import { isScope } from "@pstdio/pocketcoder-contracts";
import { fail, valueList } from "../command/cli-context";

export function parseScopes(value: string) {
  return valueList(value).map((item) => {
    if (!isScope(item)) fail(`unknown scope: ${item}`);
    return item;
  });
}
