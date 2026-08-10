# `@pstdio/pocketcoder-testkit`

Shared fixtures and contract tests for PocketCoder packages.

## Why it exists

Store adapters, runtime code, and server tests should exercise the same
realistic behavior instead of maintaining separate hand-written fakes. This
package keeps those reusable test tools in one place.

## What it does

- Provides a fake workspace driver with inspectable runtime state.
- Starts a local fake AgentAPI service for relay and conversation tests.
- Provides valid template and snapshot fixtures for common workspace shapes.
- Registers the shared store contract suite against a supplied store adapter.

This is a private test-only package. Production applications do not import it.
