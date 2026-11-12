# Managed runtime consumer

This headless backend example uses the public SDK with a sessions-only key.
Configure a profile in the controller's principals file first; see
[consumer setup](../../../docs/managed-consumers.md).

```sh
POCKETCODER_URL=http://localhost:8090 \
POCKETCODER_KEY=your-consumer-key \
POCKETCODER_PROFILE=chat \
bun examples/clients/managed-runtime/run.ts 'Hello'
```

Keep that backend key outside all workspace mounts. The consumer stores no
profile revision, credential binding or request body. A retry supplies the same
request ID, message and input IDs. Its business authorization check remains the
consumer's responsibility. Files upload once; the conversation feed owns the
merged view; one session cancel stops all queued and running work.
