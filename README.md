# Skydeo Landing MCP

Hosted control plane for creating, previewing, revising, and eventually publishing
Skydeo landing pages through Model Context Protocol clients.

## Documentation

- [`docs/README.md`](docs/README.md) — documentation index
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — layer-by-layer integration,
  trust boundaries, request flow, and implementation status

## Current milestone

This repository currently provides a deploy-closed draft and preview workflow:

- Streamable HTTP MCP transport through Cloudflare Agents SDK
- a Cloudflare Access OAuth integration for Skydeo team identity
- `create_draft`, `get_draft`, and `update_draft` MCP tools
- a typed landing-draft state machine
- one SQLite-backed Durable Object per draft
- one isolated Sandbox preview runtime per draft
- immutable SHA-256 revisions with revision-bound, tokenized preview URLs
- no production publishing capability or credentials

The `/mcp` route is disabled by default. `npm run dev` explicitly enables a local-only
mode, while `npm run dev:access` exercises the complete Access OAuth flow after local
secrets are configured. A deployment made from this scaffold will return `503` from
the OAuth and MCP routes instead of exposing an unauthenticated service.

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
revision. Preview URLs are capability URLs containing an unguessable Sandbox token;
anyone who receives one can view that revision, so they must not be posted publicly.

## Planned capability sequence

1. Provision the Access application and OAuth KV namespace, then enable Access mode.
2. Create isolated repository workspaces from a pinned `skydeo-landings` revision
   instead of accepting complete HTML.
3. Put preview access behind application-level authentication.
4. Add validation and structured landing-page edit operations.
5. Add a durable, explicitly approved publish workflow with production safeguards.

The MCP session is not the source of truth for a draft. Each draft is addressed by a
stable Skydeo-scoped ID and stored in its own Durable Object so work survives client
reconnections and can be resumed from different MCP hosts.
