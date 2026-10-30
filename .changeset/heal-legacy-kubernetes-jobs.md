---
"@pstdio/pocketcoder-cli": patch
---

Recover legacy Kubernetes Job identities at controller startup instead of blocking `pcd db migrate`, and keep termination proof for Jobs already being deleted. Removes `pcd db bind-kubernetes-job`.
