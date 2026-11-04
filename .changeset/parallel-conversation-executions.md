---
"@pstdio/pocketcoder-cli": minor
---

Add the `parallel-conversations` workload capability: an adapter that advertises it with `request-lookup` and `deduplicated-accept` runs requests from different conversations of one workspace in parallel, each conversation still one request at a time. Cancellations from several conversations no longer compete for a single relay slot, and a request waiting for input projection capacity is retried without failing readiness.
