# `@pstdio/pocketcoder-egress`

The restricted-network sidecar for PocketCoder workspaces.

## Why it exists

A workspace with `network.mode: restricted` must not enforce its own network
rules. This sidecar places outbound access behind a separate default-deny proxy
and reports the result to the control plane.

## What it does

- Loads and validates the network policy prepared for one workspace or warm
  pool runtime.
- Configures the shared network namespace so outbound HTTP and HTTPS traffic
  passes through its HTTP/CONNECT proxy.
- Applies allow rules, blocks other destinations, and sends bounded audit
  events to `pocketcoder-server` with a short-lived runtime token.
- Relays the agent's control-plane connection and exposes local health and
  readiness endpoints.

The Docker and Kubernetes drivers start this application only for restricted
templates. It is private deployment infrastructure, not a public proxy server.
