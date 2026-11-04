---
"@pstdio/pocketcoder-cli": patch
---

Launches that fail before reaching the provider now fail promptly with their cause instead of waiting for registration to expire. Cleanup that cannot yet prove what exists backs off instead of retrying every scheduler tick. `/readyz` reports a `shared-storage` check for Kubernetes shared input storage, with a reason when it fails, and shared storage errors name their cause.
