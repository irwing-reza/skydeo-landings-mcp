# Preview lifecycle verification

This runbook verifies the preview lifecycle against a real Worker, Durable Object,
and Sandbox container. It does not deploy code. Run production steps only after an
authorized operator has approved creating and destroying disposable production
drafts.

## What the smoke test proves

`npm run smoke:lifecycle` uses the MCP API instead of internal test hooks. It:

1. creates a preview and verifies its unique HTML marker is served;
2. revokes it and verifies the saved URL immediately fails closed with HTTP 410;
3. polls until the alarm destroys the Sandbox and the draft reaches `cleaned_up`;
4. repeats revocation and verifies `cleaned_up_at` does not change;
5. creates another preview, waits for its real TTL, verifies HTTP 410, and waits
   for alarm-driven Sandbox cleanup.

The expiry request can observe either `expired` or `cleaned_up`. The alarm may win
the race and finish cleanup before the request reads state. The structured
`preview_expired` event is the authoritative evidence that the alarm observed the
expired state.

An explicit `repository` scenario creates a bounded TacoGraph headline edit
through `manage_landing`, requires canonical validation and rendered-route
inspection, fetches the protected Astro preview, verifies persisted status,
revokes it, and waits for repository Sandbox destruction. It never requests or
confirms publishing.

## Local container and alarm smoke test

Docker Desktop, OrbStack, or another Docker-compatible engine must be running.
Use the minimum supported TTL so the complete test finishes quickly:

```sh
npx wrangler dev --local --port 8787 \
  --var MCP_AUTH_MODE:local \
  --var PREVIEW_HOSTNAME:localhost:8787 \
  --var PREVIEW_TTL_SECONDS:60
```

In another terminal:

```sh
npm run smoke:lifecycle
```

Keep the Wrangler terminal output. A passing run should be paired with structured
events for both drafts, including:

- `build_passed`
- `preview_opened`
- `preview_revoked`
- `preview_expired`
- `preview_access_denied` with `state` set to `revoked`, `expired`, or
  `cleaned_up`
- `preview_cleaned_up`

Run the complete static and packaging checks separately:

```sh
npm run check
npm run deploy:dry-run
```

`wrangler deploy --dry-run` builds and validates the configured container but does
not upload or deploy it.

## Authorized production smoke test

The script refuses non-local targets unless the operator explicitly opts in. Use
a short-lived MCP OAuth access token with `landings:read` and `landings:write`, plus
a Cloudflare Access service token allowed by the preview application. Keep all
values out of shell history and source control.

Before creating any remote disposable draft, the script calls the read-only
`get_service_status` tool and refuses to continue unless repository-backed
editing and repository-workspace cleanup are both explicitly ready while
publishing remains disabled. A failed or missing preflight is terminal and must
not be bypassed by running individual smoke steps manually.

```sh
export ALLOW_REMOTE_LIFECYCLE_SMOKE=1
export LIFECYCLE_SMOKE_BEARER_TOKEN='<short-lived MCP OAuth token>'
export PREVIEW_ACCESS_CLIENT_ID='<Access service-token client ID>'
export PREVIEW_ACCESS_CLIENT_SECRET='<Access service-token client secret>'
npm run smoke:lifecycle -- --mcp-url https://landing-mcp.skydeo.com/mcp
```

Run only the repository-backed disposable scenario with:

```sh
npm run smoke:lifecycle -- \
  --mcp-url https://landing-mcp.skydeo.com/mcp \
  --scenario repository
```

Before running, start a filtered Workers log tail or use Workers Observability.
Correlate every smoke result by `draftId`; verify one `sandbox.destroy` success and
one `preview_cleaned_up` event per draft, and no `preview_cleanup_failed` event.
Confirm the two disposable Sandbox instances are absent after cleanup.

Do not run the production command merely to validate authentication. It creates
draft state and Sandbox containers and intentionally destroys those containers.

## Current cleanup boundary

Cleanup is deterministic and idempotent for a known draft: its Durable Object
derives one stable Sandbox ID and destroys that Sandbox after expiry or revocation.
There is not yet a fleet-wide orphan discovery or sweep. Containers left behind by
missing/corrupt draft state, deleted Durable Objects, earlier releases, or runtime
failures outside the per-draft retry loop will not be discovered automatically.

A future orphan reconciler needs a fleet inventory source, ownership labels,
minimum-age protection, a dry-run report, bounded deletion batches, and auditable
events before it may destroy anything.

## Canonical repository integration gate

Repository-backed headline drafts use the confirmed immutable inputs:

- the canonical remote URL for `skydeo-landings`; and
- the exact initial commit SHA to pin for workspace creation.

The headline operation now checks out and validates the exact base, edits only
the resolved Astro page, persists a tree-derived revision, renders an Astro
preview, and reuses the verified workspace for later headline revisions. Add
remaining operations in this order: body copy, CTA, SEO metadata, and image
replacement. Do not accept a floating branch as the draft base and do not add
publish credentials as part of those slices.
