# Skydeo Landing MCP

Hosted control plane for creating, previewing, revising, and eventually publishing
Skydeo landing pages through Model Context Protocol clients.

## Documentation

- [`docs/README.md`](docs/README.md) — documentation index
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — layer-by-layer integration,
  trust boundaries, request flow, and implementation status

## Current milestone

This repository currently provides a production-authenticated draft and preview workflow:

- Streamable HTTP MCP transport through Cloudflare Agents SDK
- a Cloudflare Access OAuth integration for Skydeo team identity
- `create_draft`, `get_draft`, and `update_draft` MCP tools
- a typed landing-draft state machine
- one SQLite-backed Durable Object per draft
- one isolated Sandbox preview runtime per draft
- immutable SHA-256 revisions with revision-bound preview URLs
- a fail-closed preview proxy that verifies Cloudflare Access assertions before
  forwarding production preview traffic to a Sandbox
- no production publishing capability or credentials

The deployed `/mcp` route uses Cloudflare Access-backed OAuth. `npm run dev`
explicitly enables a local-only mode, while `npm run dev:access` exercises the
complete Access OAuth flow after local secrets are configured.

## Local checks

```sh
npm run cf-typegen
npm run check
```

Docker is required when starting the Sandbox-backed Worker locally:

```sh
npm run dev
```

The first container build can take several minutes. The MCP endpoint is available
at `http://localhost:8787/mcp`, and health is available at
`http://localhost:8787/healthz`.

The repository includes a project-scoped Codex MCP configuration at
`.codex/config.toml`. Trust the repository, keep `npm run dev` running, and restart
Codex (or open a new task) to make the `skydeo_landing` tools available directly in
the app, CLI, or IDE extension. The configuration allow-lists only status and the
draft/create/update workflow; it contains no publish tool.

`create_draft` accepts a hostname, base revision, and complete HTML document.
`update_draft` replaces the HTML and requires the current revision as
`expected_revision`, preventing one editor from silently overwriting another.
Every successful create or update returns a preview URL for that immutable HTML
revision. Local preview URLs remain development-only capability URLs. Production
preview hostnames are routed through the Worker and require a valid assertion from
the wildcard Cloudflare Access preview application before Sandbox proxying.

## Planned capability sequence

1. Add preview expiration, revocation, and abandoned-container cleanup.
2. Create isolated repository workspaces from a pinned `skydeo-landings` revision
   instead of accepting complete HTML.
3. Add validation and structured landing-page edit operations.
4. Add a durable, explicitly approved publish workflow with production safeguards.

The MCP session is not the source of truth for a draft. Each draft is addressed by a
stable Skydeo-scoped ID and stored in its own Durable Object so work survives client
reconnections and can be resumed from different MCP hosts.
