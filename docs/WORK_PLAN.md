# Skydeo Landing MCP work plan

This document is the tracked implementation plan for turning the current draft
and preview foundation into one user-facing landing-page workflow. Update the
status table and milestone checklists as work lands.

## Product outcome

Users should be able to describe a new landing page or an update to an existing
page in natural language and move through one coherent experience:

```text
request -> resolve page -> draft -> validate -> preview -> revise
        -> request publish -> confirm -> repository automation
```

Headline, copy, CTA, SEO, image, and source-edit operations are internal details.
Users should not have to select or sequence those operations themselves.

The intended public MCP boundary is:

- `manage_landing` for discovery, new pages, existing-page updates, previews,
  revisions, status, and publish requests.
- `confirm_publish` as a separate, explicit, auditable production boundary.

## Current status

| Area | Status | Notes |
| --- | --- | --- |
| Production authentication | Complete | Cloudflare Access-backed OAuth and scoped tools |
| Protected previews | Complete | Access assertion and lifecycle checks before proxying |
| Preview lifecycle | Complete | TTL, revoke, alarms, cleanup, structured events |
| Local lifecycle verification | Complete | Real containers, alarms, expiry, revoke, repeated cleanup |
| Production lifecycle verification | Conditionally authorized | Run one disposable test only after repository-backed cleanup and preflight checks are complete |
| Canonical repository integration | Boundary complete | Temporary fork, `master`, pinned SHA, read-only checkout token, PR-only publishing, and advancement policy confirmed |
| Unified landing workflow | In progress | `manage_landing` now connects one bounded existing-page headline update and later headline revisions to repository-backed drafts; create, other edit types, and publish remain closed |
| Repository-backed previews | In progress | Exact-SHA checkout, deterministic install, canonical validation, tree-derived revisions, reusable workspaces, Astro rendering, and cleanup are connected for headline updates |
| Structured editing | In progress | `replace_headline` is implemented with a single-page source boundary; copy, CTA, SEO, image, and layout operations remain planned |
| Publish approval and adapter | In progress | Separate `confirm_publish` boundary is registered but fails closed; no confirmation records or production capability exist |
| Fleet orphan reconciliation | Planned | Current cleanup is per known draft only |

## Confirmed temporary repository boundary

The temporary canonical boundary selected on July 22, 2026 is:

- remote: `git@github.com:irwing-reza/skydeo-landings.git`;
- release ref: `refs/heads/master`;
- publishing identity: a separate narrowly scoped GitHub App; and
- publishing method: pull requests only.

An authorized read-only fetch found `master` at
`010829fa4235fb312e6706d0c8a050c2f8084499`. The earlier candidate
`985a83fbffd6f2165a86095f266b5cdaae0ee551` is its direct parent and is reachable
from `master`. The current commit
`010829fa4235fb312e6706d0c8a050c2f8084499` is the selected initial pinned base.
Detached checkouts will use a fine-grained token restricted to this repository
with Contents read-only and no write permissions.

## Milestone 1: Confirm the repository boundary

**Status: Boundary decisions complete; provisioning belongs to implementation**

- [x] Confirm the temporary canonical remote URL.
- [x] Confirm `010829fa4235fb312e6706d0c8a050c2f8084499` as the clean initial commit SHA.
- [x] Choose a repository-scoped fine-grained token with Contents read-only for draft workspaces.
- [x] Choose a separate narrowly scoped GitHub App for publishing.
- [x] Confirm `npm run check` and `npm run build` as canonical validation.
- [x] Decide that publishing creates pull requests only.
- [x] Require explicit operator approval to advance the base SHA after verifying reachability and validation.

Acceptance criteria:

- Every draft records an immutable remote URL and base SHA.
- No draft begins from a floating branch or dirty local checkout.
- Checkout credentials cannot publish.
- Publishing credentials are unavailable to ordinary preview operations.

Remote evidence and the confirmed boundary decisions are recorded in
`docs/REPOSITORY_BOUNDARY.md`. Credential provisioning remains an implementation
step and must preserve the separation described above.

## Milestone 2: Define the unified workflow contract

**Status: Contract complete; initial runtime orchestration implemented**

Define `manage_landing` around workflow state rather than exposing many editing
tools. A provisional request shape is:

```ts
{
  request: string;
  draft_id?: string;
  expected_revision?: string;
}
```

Provisional workflow states:

- `awaiting_details`
- `preparing_workspace`
- `editing`
- `validation_failed`
- `preview_ready`
- `awaiting_publish_confirmation`
- `publishing`
- `published`
- `failed`

Every response should include the resolved page identity, draft ID, immutable
revision, concise change summary, validation status, available preview URL, and
the next user action.

The typed wire contract, intent values, workflow states, and guarded state
transitions live in `src/domain/landing-workflow.ts`. Intent classification is
implemented independently of internal editing primitives. The MCP tool now
resolves initial update requests without allocating a Sandbox and maps persisted
legacy draft reads into the unified result shape. Create, edit, and publish
requests fail closed with no side effects until repository-backed workflow state
can be persisted safely.

Acceptance criteria:

- One natural-language request can start either a new-page or update flow.
- Continuing revisions require only `draft_id`, expected revision, and intent.
- The model does not need to expose internal editing primitives to users.
- Publishing cannot occur through an ordinary update request.

## Milestone 3: Resolve intent and page identity

**Status: Resolver complete and MCP-integrated; repository integration pending**

Classify requests as:

- create a new landing page;
- update an existing page;
- continue an existing draft;
- inspect workflow status; or
- request publishing.

Resolve existing pages in this order:

1. exact production URL;
2. registered hostname;
3. subdomain;
4. known page or product name; and
5. source path.

If one page matches confidently, continue. If multiple pages match, ask one
consolidated question. Never silently choose between ambiguous production pages.

Deterministic discovery derives page identities from repository source paths
and exact registered hostnames. The locally observed candidate snapshot is
explicitly non-authoritative and cannot be used for checkout. Update requests
can now resolve, summarize, detect actionable changes, and produce one
consolidated question without allocating a Sandbox. `manage_landing` exposes
that safe discovery path and refuses actionable repository work while the
repository boundary remains unconfigured.

Acceptance criteria:

- `TacoGraph`, `tacograph`, and `https://tacograph.skydeo.com/` resolve to
  `src/domains/tacograph/pages/index.astro`.
- A vague but uniquely resolved update request returns a page summary and one
  request for the desired changes.
- No Sandbox is created until the request contains an actionable change.
- A new-page request cannot accidentally overwrite an occupied repository route.

## Milestone 4: Create repository-backed draft workspaces

**Status: Connected for bounded existing-page headline updates**

- [x] Create one stable Sandbox per draft.
- [x] Clone or fetch the configured canonical repository.
- [x] Check out the exact pinned base SHA in detached mode.
- [x] Persist remote, base SHA, page path, hostname, actor, and workspace ID.
- [x] Install dependencies deterministically.
- [x] Reuse the workspace for later revisions of the same draft.
- [x] Represent revisions using repository tree state rather than arbitrary HTML.
- [x] Connect workspace destruction to the existing preview lifecycle.

The internal repository-draft entrypoint reads the canonical boundary only from
typed Worker configuration. It obtains the checkout PAT only from the required
`REPOSITORY_CHECKOUT_TOKEN` Worker secret and passes it to a fixed Sandbox
command as an invocation-scoped environment variable. The PAT is never accepted
through MCP or persisted. Failed partial checkouts are destroyed immediately;
successful but abandoned repository workspaces share the existing TTL, revoke,
alarm, and idempotent Sandbox destruction path. A workspace becomes ready only
after `npm ci --no-audit --no-fund`, `npm run check`, and `npm run build` succeed
sequentially in the detached checkout. Each command has a fixed timeout and a
minimal non-secret environment. Failed command output is redacted and bounded
before it can reach durable events or callers, and every checkout, install, or
validation failure enters the same immediate destruction and alarm-retry path.
`manage_landing` now exposes the repository workspace only for a resolved,
unambiguous `replace_headline` operation. The fixed edit command accepts the page
path and headline through an invocation-scoped environment, rejects dynamic or
multi-region `h1` markup, and verifies that only the resolved Astro source file
changed. Git's native tree object ID is persisted, while the public 64-character
revision is a deterministic SHA-256 digest of the base commit and tree ID. Later
headline revisions verify both the expected public revision and the persisted
tree before reusing the same workspace. Failed revisions restore the last valid
tree; if restoration cannot be verified, the workspace is retired through the
same destruction and alarm-retry path.

Acceptance criteria:

- Draft source is reproducible from its stored base SHA and change record.
- Repository credentials and build output never enter preview responses.
- Expired and revoked drafts destroy their repository workspaces.
- Repeated cleanup remains idempotent.

## Milestone 5: Implement the new-page branch

**Status: Planned**

Port the policies from the repository's `new-landing-page` and `shape-seo`
skills into the service workflow:

- infer or collect the title and exact production URL;
- perform repository-only URL availability checks;
- ask at most one consolidated intake question;
- create an internal SEO brief;
- inspect design guidance, tokens, layouts, and approved brand assets;
- create the final routed Astro page directly;
- add only an exact custom domain when required;
- update routing documentation when routing changes; and
- validate and return one preview without deploying.

Acceptance criteria:

- The user experiences one workflow rather than two separate skills.
- New pages preserve the existing repository's SEO and brand rules.
- The workflow never queries or mutates production infrastructure for URL checks.
- New-page previews do not require a duplicate static HTML implementation.

## Milestone 6: Implement the existing-page update branch

**Status: First operation implemented**

For a vague request such as “I want to update the TacoGraph page”:

1. resolve the existing route;
2. inspect its current structure and metadata;
3. return a compact page summary; and
4. ask one question requesting all desired changes.

For a concrete request, proceed directly to a repository-backed draft without a
new-URL check or full SEO intake unless those concerns are part of the request.

Acceptance criteria:

- Existing routes are never treated as new pages.
- Unrelated page content and routing configuration remain unchanged.
- Vague requests do not create unnecessary containers.
- Concrete requests reach a validated preview without an extra approval gate.

## Milestone 7: Add internal structured editing operations

**Status: In progress; first operation implemented**

Initial internal operations:

- [x] `replace_headline`
- `update_copy`
- `update_cta`
- `update_seo_metadata`
- `replace_image`
- `apply_page_change` for bounded layout or source changes

Each operation must target a resolved page and known section, preserve unrelated
source, validate the expected revision, and produce a structured change record.
Ambiguous or excessively broad changes should return `awaiting_details` rather
than guessing across the repository.

Acceptance criteria:

- Operations compose within one edit request.
- Every revision has a human-readable and machine-readable change summary.
- Image changes use approved or explicitly supplied assets.
- The bounded escape hatch cannot edit deployment or unrelated application files.

## Milestone 8: Complete the validate, preview, and revise loop

**Status: Planned**

After each edit batch:

1. run any required generation or formatting;
2. run `npm run check`;
3. run `npm run build`;
4. start or reuse the Astro preview;
5. inspect the affected route;
6. persist an immutable revision; and
7. return the preview and change summary.

Subsequent requests reuse the same `draft_id` and require `expected_revision`.
Revision conflicts fail rather than silently overwriting another edit.

Acceptance criteria:

- Invalid builds never replace the last valid preview revision.
- Preview URLs remain revision-bound and lifecycle-protected.
- Users can iterate in natural language without starting a new workflow.
- Validation failures provide actionable, non-secret diagnostics.

## Milestone 9: Add publish request and confirmation records

**Status: Security boundary registered; durable records planned**

`confirm_publish` is now a distinct MCP tool guarded by `landings:publish`.
Until expiring one-time confirmation records and the repository adapter exist,
it returns an explicit error without loading or mutating a draft, consuming a
token, accessing a repository, or taking a production action. Intent-to-scope
routing for `manage_landing` is centralized and verified independently.

`manage_landing` may request publishing but must not complete it. A publish
request should record and return:

- hostname and page path;
- base and proposed revision;
- files changed;
- validation results;
- preview URL;
- intended publish method; and
- an expiring, one-time confirmation token.

`confirm_publish` must recheck actor, organization, `landings:publish`
permission, token validity, revision equality, repository target, validation
identity, and idempotency state.

Acceptance criteria:

- No natural-language phrase alone causes production publication.
- Expired, reused, or revision-mismatched tokens fail closed.
- Publish confirmation is auditable and bound to one immutable revision.
- Repeated confirmation cannot create duplicate commits or pull requests.

## Milestone 10: Implement the repository publishing adapter

**Status: Planned**

- [ ] Create a scoped branch or commit after confirmation.
- [ ] Include only files authorized by the draft change record.
- [ ] Push with narrowly scoped service credentials.
- [ ] Create a pull request unless controlled direct commits are explicitly chosen.
- [ ] Track CI and repository deployment status asynchronously.
- [ ] Persist commit SHA, pull-request URL, deployment IDs, and production URL.
- [ ] Let repository automation deploy rather than calling Cloudflare deployment
      APIs from the MCP Worker.

Acceptance criteria:

- Publishing is retryable and idempotent.
- Repository or CI failures do not lose the approved draft state.
- The MCP can report progress after the initiating session disconnects.
- Production state links back to the approving actor and immutable draft revision.

## Milestone 11: Verification matrix

**Status: Planned**

Add automated and container-backed verification for:

- new-page and existing-page intent resolution;
- exact, fuzzy, and ambiguous page identity;
- vague versus actionable update requests;
- each structured edit operation;
- exact-SHA repository checkout;
- validation and build failures;
- immutable preview revisions;
- concurrent revision conflicts;
- revocation or expiration during a build;
- publish-token expiry, reuse, and revision mismatch;
- commit or pull-request idempotency;
- cleanup after successful and failed workflows; and
- the complete TacoGraph update workflow.

The end-to-end TacoGraph scenario is:

```text
“Update the TacoGraph page”
-> resolve the existing page
-> summarize and request desired changes
-> apply a concrete headline, copy, or CTA request
-> validate and preview
-> accept another revision
-> request publish
-> confirm the immutable revision
-> create the repository change
-> report automation status
```

## Milestone 12: Reconcile fleet-wide orphan Sandboxes

**Status: Planned**

This is separate from ordinary per-draft cleanup:

- [ ] inventory Sandbox instances from an authoritative fleet source;
- [ ] match ownership labels to reachable draft records;
- [ ] protect active, recent, or uncertain instances;
- [ ] produce a non-destructive dry-run report;
- [ ] require explicit enablement for deletion;
- [ ] delete only in bounded batches; and
- [ ] emit auditable reconciliation events.

Acceptance criteria:

- Dry-run mode is the default.
- No active or uncertain Sandbox is deleted.
- Every deletion has an ownership decision and audit event.
- Repeated sweeps are safe and idempotent.

## Immediate next actions

1. Exercise the conditionally authorized disposable production lifecycle test
   only after its new read-only repository-workspace preflight passes.
2. Add the next bounded existing-page operation, preserving tree verification
   and rollback behavior.
3. Keep `manage_landing` create, unsupported edit, and publish-request branches
   fail closed until their corresponding durable workflow operations exist.
