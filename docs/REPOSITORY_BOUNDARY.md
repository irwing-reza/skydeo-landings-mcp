# Landing repository boundary

This records what can be established locally without trusting a dirty checkout
or contacting production systems. It is evidence for configuration, not the
configuration itself.

## Confirmed temporary repository boundary

On July 22, 2026, the user selected the personal fork as the temporary
canonical repository for this phase:

- Remote: `git@github.com:irwing-reza/skydeo-landings.git`
- Canonical release ref: `refs/heads/master`
- Publication method: pull requests only
- Publishing identity: a separate narrowly scoped GitHub App

An authorized read-only remote fetch established that `master` pointed to
`010829fa4235fb312e6706d0c8a050c2f8084499` and that the previously observed
candidate `985a83fbffd6f2165a86095f266b5cdaae0ee551` is its direct parent. Both are
immutable remote Git objects. The user selected the current `master` commit,
`010829fa4235fb312e6706d0c8a050c2f8084499`, as the initial pinned base SHA.

## Earlier local evidence

- Checkout: `/Users/irwing/Documents/skydeo-landings`
- Organization repository observed as local remote `skydeo`:
  `git@github.com:skydeo-aviato/skydeo-landings.git`
- Personal fork observed as local remote `origin` and now selected temporarily:
  `git@github.com:irwing-reza/skydeo-landings.git`
- Candidate base commit: `985a83fbffd6f2165a86095f266b5cdaae0ee551`
- Local branch and both local remote-tracking `master` refs point to that commit.
- The candidate commit is an immutable Git object whose subject is
  `feat(landing): add tacograph.skydeo.com`.
- The working tree is not clean: it has a local `wrangler.jsonc` modification.
  Runtime checkout code must not copy or derive a base from this working tree.
- At the candidate commit, `package.json` defines `npm run check` as
  `astro check` and `npm run build` as `astro build`. These are the canonical
  workflow validation commands described by the repository skill.
- At the candidate commit, `wrangler.jsonc` registers exact production routes
  for `pizza-consumer.skydeo.com` and `tacograph.skydeo.com`.

The remote, release ref, and exact initial base SHA are confirmed for this phase.
Draft workspaces must check out that SHA in detached mode and may not substitute
the current value of the moving release ref.

## Confirmed security and release choices

- Detached draft checkouts will use a fine-grained GitHub personal access token
  restricted to this repository with Contents read-only and no write permissions.
  The token must be stored as a Cloudflare secret and never in source, ordinary
  configuration, logs, draft records, or Sandbox responses.
- Publishing will use a separate narrowly scoped GitHub App identity. Preview
  operations and draft containers must never receive this credential.
- Publishing will create pull requests only; direct commits are out of scope.
- The pinned base SHA advances only through an explicit operator-approved update.
  Before an update is accepted, the service workflow must verify that the chosen
  commit is reachable from `refs/heads/master` and passes canonical validation.
  Signed repository-event automation may be considered later but is not part of
  the initial implementation.

## Production lifecycle verification decision

One disposable production lifecycle test is authorized after repository-backed
workspace cleanup is implemented. The test must create a clearly identified test
draft and Sandbox, verify protected preview access, revoke it, confirm workspace
destruction, and retain only audit records. This is conditional authorization;
the test must not run before the cleanup implementation and its preflight checks
are complete.

No Cloudflare production state was queried or changed while recording these
decisions. GitHub access was read-only.

## Checkout credential provisioning

The read-only fine-grained PAT is provisioned only as the Worker secret
`REPOSITORY_CHECKOUT_TOKEN`. Its value must be entered interactively with
`wrangler secret put`; it must never be placed in `wrangler.jsonc`, `.dev.vars`,
source, an MCP request, or a draft record. Provisioning and rotating this secret
does not authorize provisioning or exposing the separate publishing identity.

For each exact-SHA fetch, the Worker passes the secret as a per-command Sandbox
environment variable to a fixed container script. Git receives it through a
fixed `GIT_ASKPASS` helper with credential helpers disabled. The remote stored in
Git configuration is a credential-free HTTPS URL, while the draft record retains
the confirmed canonical SSH remote. The helper unsets the token immediately
after fetch, and checkout output is reduced to the verified commit SHA.

The implementation is intentionally dormant until the token is provisioned and
the unified repository-backed edit flow is connected. Ordinary preview
workspaces never receive the publishing GitHub App identity.
