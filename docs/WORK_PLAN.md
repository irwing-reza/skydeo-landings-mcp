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
| Production lifecycle verification | Preflight passed; async retest pending | The authorized repository preflight passed; the synchronous timeout was addressed locally, but no new production repository draft should be created until this slice is deployed |
| Canonical repository integration | Boundary complete | Temporary fork, `master`, pinned SHA, read-only checkout token, PR-only publishing, and advancement policy confirmed |
| Unified landing workflow | In progress | `manage_landing` composes bounded existing-page edits; the asynchronous replacement for the timed-out production path is implemented locally, while create and publish remain closed |
| Repository-backed previews | In progress | Exact-SHA checkout, deterministic install, canonical validation, tree-derived revisions, reusable workspaces, rendered-route inspection, and cleanup are connected for bounded edit batches |
| Asynchronous repository execution | Durable step boundaries implemented locally; production retest pending | Alarms persist deterministic Container process IDs, dispatch or poll one step per invocation, expose phase and step polling, and never await a multi-minute repository command |
| Structured editing | In progress | The initial operation set is implemented with static-target and single-page boundaries; broader layout/source transformations remain closed |
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

**Status: Connected for bounded existing-page edit batches**

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
unambiguous structured edit batch. The fixed edit command accepts the page path
and typed operations through an invocation-scoped environment, rejects dynamic
or multi-region targets, and verifies that only the resolved Astro source file
changed. Git's native tree object ID is persisted, while the public 64-character
revision is a deterministic SHA-256 digest of the base commit and tree ID. Later
revisions verify both the expected public revision and the persisted tree before
reusing the same workspace. Failed revisions restore the last valid tree; if
restoration cannot be verified, the workspace is retired through the same
destruction and alarm-retry path.

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

**Status: Initial bounded operation set implemented**

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

**Status: In progress; initial bounded operation set implemented**

Initial internal operations:

- [x] `replace_headline`
- [x] `update_copy` for one marked or unambiguous hero paragraph
- [x] `update_cta` for one marked or unambiguous hero link
- [x] `update_seo_metadata` for static title and description targets
- [x] `replace_image` for one marked or unambiguous hero image
- [x] `apply_page_change` for ordering two explicitly identified sections

The deterministic request grammar uses quoted values so several fields can be
composed without guessing where one value ends. For example:

```text
Update TacoGraph: headline to "Cook smarter"; hero copy to "Plan every service";
CTA label to "Start free"; CTA URL to "/signup"; SEO title to "TacoGraph planning";
image source to "/images/hero.webp"; image alt to "TacoGraph dashboard"
```

Static `data-landing-role="body-copy"`, `data-landing-role="cta"`, and
`data-landing-role="image"` markers take precedence. Without markers, the
operation proceeds only when the `h1` container has exactly one compatible
target. Layout edits accept only `move section "a" before|after section "b"`
where both sections have a unique `id` or `data-section`. Arbitrary patches,
component edits, deployment files, scripts, styles, and routing changes remain
outside this operation.

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

**Status: Durable per-step asynchronous execution implemented locally; production retest pending**

After each edit batch:

1. run any required generation or formatting;
2. run `npm run check`;
3. run `npm run build`;
4. start or reuse the Astro preview;
5. inspect the affected route and confirm every requested value rendered;
6. persist an immutable revision; and
7. return the preview and change summary.

Subsequent requests reuse the same `draft_id` and require `expected_revision`.
Revision conflicts fail rather than silently overwriting another edit.

### Production timeout finding and asynchronous execution slice

On July 22, 2026, the deployed `skydeo_landing_prod` MCP passed the required
read-only preflight: repository-backed editing and workspace cleanup were enabled,
all six bounded edit types were advertised, and publishing remained disabled. Two
authorized composed TacoGraph edit attempts then exceeded the MCP client's
120-second `tools/call` deadline while `manage_landing` synchronously awaited
repository preparation, canonical validation, Astro build, and preview readiness.
Neither call returned its already-generated draft ID, so the caller could not poll,
inspect, or immediately revoke the disposable workflow. No publishing tool was
called. The production end-to-end test is therefore **not passed**.

The next implementation slice must make repository work durable and asynchronous:

- [x] Accept an idempotency key for each initial mutation request.
- [x] Create and persist the draft record, schedule cleanup, and return its
      `draft_id` and `preparing_workspace` state before slow repository work starts.
- [x] Continue checkout, install, edits, validation, build, rendered-route
      inspection, and preview startup independently of the initiating MCP request.
- [x] Let `manage_landing` and/or `get_draft` poll durable progress through
      `preparing_workspace`, `editing`, `validation_failed`, `preview_ready`, and
      `failed` without starting duplicate work.
- [x] Make repeated requests with the same actor, organization, and idempotency key
      resolve to the same draft and operation result.
- [x] Add a bounded recovery lookup for a request whose transport disconnected
      before its draft ID reached the caller.
- [x] Define cancellation and timeout behavior so every allocated workspace is
      either retained behind an active draft lifecycle or destroyed and audited.
- [x] Persist a deterministic Container process ID and independent deadline before
      dispatching every checkout, install, check, build, edit, restore, and rendered
      verification command.
- [x] Limit each alarm invocation to one dispatch, poll, completion, readiness, or
      exposure action; never await a multi-minute Container command from an alarm.
- [x] Reconnect alarm retries to an existing process record and fail closed when
      upgrading an untracked legacy in-flight operation.
- [x] Verify deterministic retry/recovery and restart-safe persisted phases with
      unit coverage; update the container-backed repository smoke to require a
      prompt initiating response, idempotent recovery, durable polling, terminal
      observation, and cleanup.
- [ ] Run the updated container-backed smoke and verify disconnects, Worker restarts,
      alarm cleanup, and failure
      destruction with unit, container-backed, and production smoke tests.

The initiating `manage_landing` request now requires an 8-200 character
`idempotency_key` for an actionable initial repository mutation. A SHA-256-derived,
UUID-shaped draft ID is scoped to organization and actor, so retry and recovery
route to the same Durable Object without a global index. The object atomically
persists the immutable repository boundary, workspace ID, bounded edit batch,
operation deadline, and `queued` status before setting its alarm and returning.
No checkout, install, validation, build, or preview call occurs on that request.

The production alarm destruction exposed a second architectural boundary: an
alarm must not synchronously await a multi-minute Container command. Repository
execution now persists an internal step, deterministic process ID, step start,
and independent step deadline before dispatch. One alarm invocation performs at
most one bounded action: dispatch a process, poll its durable record, consume its
bounded redacted result, or advance state. It never calls `waitForExit()` and
never restarts checkout merely because an alarm invocation was destroyed.

The durable sequence distinguishes `checkout`, `install`, baseline `check` and
`build`, tree restore, bounded edit, tree snapshot, post-edit `check` and `build`,
preview server/proxy readiness, rendered-route verification, and preview
exposure. Polling exposes both the stable public phase and the more precise
internal execution step. Dispatch identity is stored before Container I/O, so a
lost dispatch response is recovered by looking up the same process ID. Terminal
process records retain logs (`autoCleanup: false`) until the coordinator has
persisted the transition.

Each command retains its existing fixed timeout and the overall operation has a
30-minute durable deadline. The coordinator also enforces the persisted step
deadline independently, kills an over-budget process, and treats Container
termination latency as failure rather than success. Revocation or expiry routes
the entire Sandbox through idempotent cleanup. Initial failures destroy the
workspace; revision failures use their own durable restore step and retain the
last valid revision only after that restore verifies successfully.

The possible prebuilt-repository Container optimization is tracked separately in
`docs/FEATURE_UPDATE_PLAN.md`. It must preserve this durable command boundary and
all canonical validation rather than serving as a correctness workaround.

Additional Container evidence from deployment `d0390dd3…` showed workspace
`sandbox-skydeo-1e21bb7fb4894db8bc69c2ce27982724` reaching `command.exec` for
the canonical `npm run check` and failing with `Command timeout after 300000ms`.
The Container reported `durationMs: 464993`; that excess wall time is treated as
timeout/termination latency, not successful check execution. At pinned SHA
`010829fa4235fb312e6706d0c8a050c2f8084499`, the repository's check script is
`astro check`. Checkout and `npm ci` therefore progressed far enough that the
read-only checkout token is not the current blocker.

The implementation deliberately retains `npm run check` and its 300-second
command timeout. Raising the timeout without evidence would hide the observed
failure mode. Durable polling now includes `execution_phase` with one of
`checkout`, `install`, `check`, `build`, or `preview`; a check transport timeout
is persisted as a bounded, redacted failure diagnostic, and an initial failure
destroys the Sandbox or schedules cleanup retry. The likely causes still to
distinguish are resource pressure on the configured `lite` Container versus a
repository-specific `astro check` stall. The next authorized run should
correlate phase timestamps and Container resource/command logs before changing
command budgets or instance sizing.

Before another production mutation, verify the prior failed workspace emitted
`repository_workspace_failed` or `repository_operation_failed` together with
`sandbox_destroyed` or `preview_cleaned_up`; if destruction failed, require
`sandbox_destroy_failed` or `preview_cleanup_failed` followed by an alarm retry.

Asynchronous acceptance criteria:

- Initial repository mutations return a durable draft ID comfortably inside the
  MCP client deadline without claiming validation or preview readiness.
- Client timeout or disconnect does not stop durable work or make its draft
  unreachable.
- Retrying an uncertain request cannot allocate a second repository workspace.
- Terminal success and failure remain observable after the initiating session ends.
- Revocation and expiry clean every known workspace, while publishing remains
  unavailable.

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

1. Review and deploy the Milestone 8 per-step dispatch/poll/completion slice
   before creating another production repository draft.
2. Repeat the authorized disposable production lifecycle test only after the
   read-only preflight passes and the initiating call returns a durable draft ID
   within the MCP deadline; then verify preview contents, persisted revision,
   revocation, and workspace destruction.
3. Verify the operation targets against real canonical pages and add explicit
   `data-landing-role` markers where existing markup is otherwise ambiguous.
4. Keep `manage_landing` create, unbounded source-edit, and publish-request branches
   fail closed until their corresponding durable workflow operations exist.
