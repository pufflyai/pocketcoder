---
"@pstdio/pocketcoder-cli": minor
"@pstdio/pocketcoder-sdk": minor
---

Remove model usage management: execution profiles no longer take `allowedModels`, budget policies only limit physical capacity, and token reservations and settlement are gone. The model gateway (agentgateway in reference deployments) owns model access and spend.
