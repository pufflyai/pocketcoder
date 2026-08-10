# `@pstdio/pocketcoder-auth`

Authentication and signing primitives shared by PocketCoder services.

## Why it exists

Machine keys, one-time runtime credentials, and signed events must use the same
formats and verification rules everywhere. This package keeps those security
rules small, reviewable, and separate from HTTP and database code.

## What it does

- Issues and parses `pkt_` machine keys while returning only a keyed secret
  digest for storage.
- Digests and verifies opaque registration and reconnect secrets.
- Signs and verifies lifecycle events.
- Issues and verifies expiring egress-audit tokens for one workspace or warm
  pool runtime.
- Redacts known PocketCoder credentials from text before it reaches logs.

This is a private workspace package used by the server, runtime, and provider
drivers. It does not store keys or decide which scopes a principal has.
