---
"@pstdio/pocketcoder-sdk": minor
"@pstdio/pocketcoder-cli": patch
"@pstdio/pocketcoder-remote": patch
---

Wait for the agent to be ready for input before sending a user message, so a workspace that is ready but still starting no longer fails with an opaque 500.
