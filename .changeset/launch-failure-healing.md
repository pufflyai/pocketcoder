---
"@pstdio/pocketcoder-cli": patch
---

Launches that fail before reaching the provider now fail promptly with their cause instead of waiting for registration to expire, and launches an earlier controller left terminating settle once no provider object exists. Cleanup that cannot yet prove what exists backs off instead of retrying every scheduler tick. A producer's 4xx refusal of an execution settles that execution as refused instead of being retried forever, other dispatch failures back off, and one execution's failures no longer fail `/readyz`. `/readyz` reports a `shared-storage` check for Kubernetes shared input storage, with a reason when it fails, and shared storage errors name their cause.
