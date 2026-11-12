import { setDefaultTimeout } from "bun:test";

// Shared CI runners can be twice as slow as a laptop. bunfig.toml cannot set this,
// and workspace test scripts pass the same value with --timeout.
setDefaultTimeout(10_000);
