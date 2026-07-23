# Feature update plan: prebuilt canonical repository image

## Status

Planned optimization. This is intentionally separate from the Milestone 8
durable execution correction. Baking a repository into an image can reduce cold
preparation time, but it does not make a multi-minute command safe to await from
a Durable Object alarm.

## Outcome

Build the Container image with an immutable, dependency-installed copy of the
canonical `skydeo-landings` repository. A new draft copies that golden workspace
into its disposable writable workspace instead of fetching and installing it at
runtime. Updates to `refs/heads/master` produce a reviewed image and Worker
release that identifies the exact source SHA it contains.

## Security and reproducibility boundary

- Use the canonical repository `git@github.com:irwing-reza/skydeo-landings.git`.
- Resolve `refs/heads/master` to an exact commit in trusted CI and build from that
  immutable SHA. Never run a floating checkout inside a draft workspace.
- Use `npm ci`, not `npm install`, and fail when the lockfile and package manifest
  disagree.
- Do not place a checkout token in a Docker `ARG`, image layer, build log, runtime
  environment, or copied workspace. CI may obtain source before the image build,
  using a repository-scoped read-only identity.
- Never include the separate PR-only publishing GitHub App identity in the image
  or a preview workspace.
- Record the source commit SHA, lockfile digest, image identifier, and Worker
  version in release metadata. Runtime must reject a configured base SHA that
  does not match the image manifest.
- Keep the golden repository read-only. Each draft receives an isolated copy and
  retains the existing lifecycle cleanup and failure-destruction rules.

## Delivery workflow

1. A GitHub event on `master` starts a trusted build workflow.
2. CI resolves and checks out the exact commit, verifies repository policy, and
   runs deterministic `npm ci`, `npm run check`, and `npm run build` gates.
3. CI builds the Container image from that already-checked-out source without
   embedding credentials.
4. The release records the exact repository SHA and lockfile digest.
5. Initially, automation opens a SHA-bump pull request in this MCP repository.
   A reviewed merge deploys the matching Worker and Container image together.
6. After rollback and observability are proven, the same gated workflow may use
   a narrowly scoped deploy hook for automatic promotion.

## Runtime workflow

1. Verify the configured pinned base SHA matches the image manifest.
2. Copy the image's golden workspace to the draft's disposable repository path.
3. Verify the copied tree and dependency metadata before editing.
4. Apply only the existing bounded operations.
5. Preserve canonical `npm run check`, `npm run build`, and rendered Astro route
   verification after every edit. Prebuilding is not permission to bypass them.
6. Continue every command through the durable dispatch/poll/completion state
   machine; an image optimization must not reintroduce synchronous alarm waits.

## Performance investigation

The July 22 production run reached the canonical `astro check` and exceeded its
300-second command timeout, with 464,993 ms of observed Container wall time.
Before increasing that timeout:

- measure CPU and memory pressure during `astro check`;
- reproduce at the pinned SHA in the production-equivalent Container;
- compare the current `lite` instance with an appropriately sized instance;
- distinguish dependency cold-start cost from the check itself; and
- retain the independent durable step deadline and kill/cleanup path.

## Rollout and rollback

- Start with manual promotion of a SHA-bump pull request.
- Keep the prior Worker version and image available for rollback.
- Fail closed on a Worker/image SHA mismatch.
- Canary one disposable draft and verify step events, preview contents,
  idempotent recovery, revocation, and Sandbox destruction before broad rollout.
- Do not enable publishing as part of this feature.

## Acceptance criteria

- A fresh draft does not perform a network checkout or `npm ci` at runtime.
- The runtime workspace is provably derived from the configured exact SHA.
- No repository or publishing credential exists in the image or draft filesystem.
- Canonical check, build, and rendered-route validation still run after edits.
- Master updates create one traceable image/Worker update with a safe rollback.
- A failed, timed-out, revoked, or expired operation still destroys its disposable
  workspace through the existing audited cleanup path.
