import { expect, test } from "bun:test";
import { isolatedEnvironment } from "./environment";

test("child processes cannot inherit another Pocketcoder deployment or provider credentials", () => {
  const env = isolatedEnvironment({
    PATH: "/bin",
    HOME: "/home/test",
    TERM: "xterm",
    OPENAI_API_KEY: "host-provider-key",
    POCKETCODER_KEY: "another-deployment-key",
    POCKETCODER_DATABASE_URL: "postgres://another-deployment",
    POCKETCODER_TEMPLATE_DIR: "/another-deployment/templates",
  });
  expect(env).toEqual({ PATH: "/bin", HOME: "/home/test", TERM: "xterm" });
});
