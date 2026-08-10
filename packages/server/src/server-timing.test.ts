import { expect, test } from "bun:test";
import { MAX_WORKSPACE_CHANGE_WAIT_SECONDS, SERVER_IDLE_TIMEOUT_SECONDS } from "./server-timing";

test("server idle timeout exceeds the longest workspace change poll", () => {
  expect(SERVER_IDLE_TIMEOUT_SECONDS).toBeGreaterThan(MAX_WORKSPACE_CHANGE_WAIT_SECONDS);
});
