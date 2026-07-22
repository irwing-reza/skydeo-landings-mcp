# Landing repository boundary

This records what can be established locally without trusting a dirty checkout
or contacting production systems. It is evidence for configuration, not the
configuration itself.

## Locally observed candidate

- Checkout: `/Users/irwing/Documents/skydeo-landings`
- Candidate canonical remote: `git@github.com:skydeo-aviato/skydeo-landings.git`
  (local remote name `skydeo`)
- Personal fork: `git@github.com:irwing-reza/skydeo-landings.git`
  (local remote name `origin`)
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

The remote URL and base SHA remain unconfirmed until an authorized, read-only
remote fetch establishes that the commit is reachable from the intended
canonical release ref. No draft workspace may use the candidate snapshot before
that confirmation.

## Security choices still required

- Choose a read-only deploy key or GitHub App installation token for detached
  draft checkouts. It must have repository contents read access only.
- Choose a separate narrowly scoped GitHub App identity for publishing. Preview
  operations and draft containers must never receive this credential.
- Choose pull requests (recommended) or explicitly controlled direct commits as
  the publication method.
- Choose the canonical release ref and define how an operator or trusted
  repository event advances the pinned base SHA after releases.

No GitHub or Cloudflare production state was queried or changed while collecting
this evidence.
