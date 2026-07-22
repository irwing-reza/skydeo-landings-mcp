# Skydeo Landing MCP documentation

This directory explains how the hosted MCP control plane is intended to work and
which parts are already present in the repository.

## Documents

- [Architecture and layer integration](ARCHITECTURE.md) — the end-to-end request
  path from an MCP client through authentication, durable draft state, Sandbox
  previews, approval, and production publishing.
- [Authentication](AUTHENTICATION.md) — Cloudflare Access, OAuth secrets, KV
  storage, local authenticated testing, and production enablement.
- [Preview lifecycle verification](LIFECYCLE_VERIFICATION.md) — safe local and
  explicitly authorized production smoke tests for expiry, revocation, alarms,
  and Sandbox cleanup.

## Status language

The architecture documentation uses three status labels:

- **Implemented** — executable code exists and is covered by the current checks.
- **Configured** — the Cloudflare binding or runtime is present, but application
  code does not use it yet.
- **Planned** — design context only; the capability must not be treated as
  available or production-safe.

The root [`README.md`](../README.md) remains the quick-start and milestone summary.
