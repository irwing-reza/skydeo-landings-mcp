import { describe, expect, it } from "vitest";

import { permissionForLandingIntent } from "../src/domain/landing-authorization";
import {
  classifyLandingIntent,
  hasActionablePageChange,
  parseReplaceHeadlineChange,
} from "../src/domain/landing-intent";
import {
  inspectLandingDraft,
  planInitialLandingRequest,
  repositoryMutationResult,
  unavailableDraftOperation,
} from "../src/domain/manage-landing";
import {
  assertLandingWorkflowTransition,
  isLandingWorkflowState,
  type ManageLandingResult,
} from "../src/domain/landing-workflow";
import { LOCAL_CANDIDATE_LANDING_SNAPSHOT } from "../src/repository/page-catalog";
import type { DraftRecord } from "../src/domain/draft";
import {
  repositoryDraftId,
  repositoryResumeStrategy,
} from "../src/domain/repository-execution";

describe("manage_landing contract", () => {
  it.each([
    ["create_page", { request: "Create a new landing page for GraphKit" }],
    ["create_page", { request: "Create a production-ready landing page for GraphKit" }],
    ["update_page", { request: "Update the TacoGraph page" }],
    ["continue_draft", { request: "Change the headline", draft_id: "draft-1" }],
    ["inspect_status", { request: "What is the status?", draft_id: "draft-1" }],
    ["request_publish", { request: "Request publish", draft_id: "draft-1" }],
  ] as const)("classifies %s intent", (expected, request) => {
    expect(classifyLandingIntent(request)).toBe(expected);
  });

  it.each([
    ["create_page", "landings:write"],
    ["update_page", "landings:write"],
    ["continue_draft", "landings:write"],
    ["inspect_status", "landings:read"],
    ["request_publish", "landings:publish"],
  ] as const)("authorizes %s with %s", (intent, permission) => {
    expect(permissionForLandingIntent(intent)).toBe(permission);
  });

  it("distinguishes a vague update from an actionable change", () => {
    expect(hasActionablePageChange("Update the TacoGraph page")).toBe(false);
    expect(hasActionablePageChange("Change the TacoGraph headline to Cook smarter")).toBe(true);
  });

  it("permits preview revision and publish-request transitions", () => {
    expect(() => {
      assertLandingWorkflowTransition("preview_ready", "editing");
      assertLandingWorkflowTransition("preview_ready", "awaiting_publish_confirmation");
    }).not.toThrow();
  });

  it("keeps publishing behind the confirmation state", () => {
    expect(() => {
      assertLandingWorkflowTransition("preview_ready", "publishing");
    }).toThrow("Invalid landing workflow transition: preview_ready -> publishing");
  });

  it("defines a stable result with unavailable values represented as null", () => {
    const result = {
      state: "awaiting_details",
      intent: "update_page",
      page: null,
      draft_id: null,
      revision: null,
      change_summary: "No changes yet",
      change_operations: [],
      execution_phase: null,
      validation: { status: "not_run", checks: [], summary: null },
      preview_url: null,
      next_action: "Identify the page and requested changes.",
    } satisfies ManageLandingResult;

    expect(result.preview_url).toBeNull();
    expect(isLandingWorkflowState(result.state)).toBe(true);
    expect(isLandingWorkflowState("draft")).toBe(false);
  });

  it("plans a vague resolved update without allocating a draft", () => {
    const result = planInitialLandingRequest(
      { request: "I want to update the TacoGraph page" },
      LOCAL_CANDIDATE_LANDING_SNAPSHOT,
    );

    expect(result).toMatchObject({
      state: "awaiting_details",
      intent: "update_page",
      draft_id: null,
      revision: null,
      preview_url: null,
      page: { source_path: "src/domains/tacograph/pages/index.astro" },
      validation: { status: "not_run" },
    });
    expect(result.next_action).toContain("all desired");
  });

  it("routes a concrete unsupported edit to the bounded headline operation", () => {
    const result = planInitialLandingRequest(
      { request: "Change the TacoGraph headline to Cook smarter" },
      LOCAL_CANDIDATE_LANDING_SNAPSHOT,
    );

    expect(result).toMatchObject({
      state: "awaiting_details",
      intent: "update_page",
      draft_id: null,
      page: { name: "TacoGraph" },
    });
    expect(result.next_action).toContain("quoted values");
  });

  it("extracts one bounded headline replacement", () => {
    expect(
      parseReplaceHeadlineChange(
        "Change the TacoGraph headline to “Cook smarter, every service”",
      ),
    ).toEqual({
      operation: "replace_headline",
      headline: "Cook smarter, every service",
    });
    expect(parseReplaceHeadlineChange("Update the TacoGraph copy")).toBeNull();
  });

  it("maps a persisted preview into the unified status response", () => {
    const result = inspectLandingDraft(draftRecord());

    expect(result).toMatchObject({
      state: "preview_ready",
      intent: "inspect_status",
      draft_id: "b03a5b3a-5382-4b63-873c-f87e35ba8966",
      revision: "a".repeat(64),
      preview_url: "https://preview.example.test",
    });
  });

  it("returns a validated repository-backed Astro preview result", () => {
    const draft = draftRecord();
    draft.repositoryPagePath = "src/domains/tacograph/pages/index.astro";
    draft.repositoryWorkspaceStatus = "ready";
    draft.repositoryTreeSha = "b".repeat(40);
    draft.repositoryChangeOperation = "replace_headline";
    draft.repositoryChangeSummary = "Replaced the TacoGraph headline.";

    expect(
      repositoryMutationResult("update_page", {
        draft,
        changeSummary: "Replaced the TacoGraph headline.",
        operationNames: ["replace_headline"],
        validation: {
          status: "passed",
          checks: ["npm run check", "npm run build"],
          summary: "The canonical repository checks passed.",
        },
      }),
    ).toMatchObject({
      state: "preview_ready",
      page: { name: "TacoGraph" },
      revision: "a".repeat(64),
      change_operations: ["replace_headline"],
      validation: { status: "passed" },
    });
  });

  it("reports durable preparation and validation failure states", () => {
    const preparing = draftRecord();
    preparing.status = "draft";
    preparing.currentRevision = "0".repeat(40);
    preparing.previewUrl = null;
    preparing.repositoryPagePath = "src/domains/tacograph/pages/index.astro";
    preparing.repositoryWorkspaceStatus = "preparing";
    preparing.repositoryOperationStatus = "queued";
    preparing.repositoryOperationPhase = "checkout";
    preparing.repositoryChangeOperation = JSON.stringify([
      { operation: "replace_headline", value: "Cook smarter" },
    ]);

    expect(inspectLandingDraft(preparing)).toMatchObject({
      state: "preparing_workspace",
      draft_id: preparing.id,
      revision: null,
      validation: { status: "pending" },
      execution_phase: "checkout",
      preview_url: null,
    });

    preparing.status = "preview_ready";
    preparing.currentRevision = "a".repeat(64);
    preparing.repositoryWorkspaceStatus = "ready";
    preparing.repositoryOperationStatus = "validation_failed";
    preparing.repositoryOperationPhase = "check";
    preparing.repositoryOperationError = "Repository check validation failed (exit code 1)";
    expect(inspectLandingDraft(preparing)).toMatchObject({
      state: "validation_failed",
      revision: "a".repeat(64),
      validation: {
        status: "failed",
        summary: "Repository check validation failed (exit code 1)",
      },
      execution_phase: "check",
    });
  });

  it("derives stable actor-scoped draft IDs for uncertain retries", async () => {
    const first = await repositoryDraftId("skydeo", "actor-1", "request-123456");
    const retry = await repositoryDraftId("skydeo", "actor-1", "request-123456");
    const otherActor = await repositoryDraftId("skydeo", "actor-2", "request-123456");

    expect(first).toBe(retry);
    expect(first).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
    expect(otherActor).not.toBe(first);
  });

  it("selects restart-safe recovery for initial and revision operations", () => {
    expect(repositoryResumeStrategy("queued", null)).toBe("continue_initial");
    expect(repositoryResumeStrategy("running", null)).toBe("reset_initial");
    expect(repositoryResumeStrategy("running", "b".repeat(40))).toBe("restore_revision");
  });

  it("does not return a revoked preview URL from unified status", () => {
    const draft = draftRecord();
    draft.previewRevokedAt = Date.now();

    expect(inspectLandingDraft(draft)).toMatchObject({
      state: "failed",
      preview_url: null,
    });
  });

  it("keeps draft edits and publish requests unavailable without mutating the draft", () => {
    const draft = draftRecord();
    const edit = unavailableDraftOperation(
      {
        request: "Change the headline",
        draft_id: draft.id,
        expected_revision: draft.currentRevision,
      },
      draft,
    );
    const publish = unavailableDraftOperation(
      { request: "Request publish", draft_id: draft.id },
      draft,
    );

    expect(edit).toMatchObject({ state: "failed", intent: "continue_draft" });
    expect(publish).toMatchObject({ state: "failed", intent: "request_publish" });
    expect(publish.change_summary).toContain("publishing is not configured");
  });
});

function draftRecord(): DraftRecord {
  return {
    id: "b03a5b3a-5382-4b63-873c-f87e35ba8966",
    organizationId: "skydeo",
    createdBy: "user-1",
    hostname: "tacograph.skydeo.com",
    status: "preview_ready",
    baseRevision: "0".repeat(64),
    currentRevision: "a".repeat(64),
    approvedRevision: null,
    previewUrl: "https://preview.example.test",
    productionUrl: null,
    html: "<h1>TacoGraph</h1>",
    repositoryRemoteUrl: null,
    repositoryReleaseRef: null,
    repositoryBaseSha: null,
    repositoryPagePath: null,
    repositoryWorkspaceId: null,
    repositoryWorkspaceStatus: null,
    repositoryPreparedAt: null,
    repositoryTreeSha: null,
    repositoryChangeOperation: null,
    repositoryChangeSummary: null,
    repositoryOperationStatus: null,
    repositoryOperationPhase: null,
    repositoryOperationError: null,
    repositoryOperationDeadlineAt: null,
    repositoryOperationAttempt: 0,
    repositoryIdempotencyKey: null,
    previewExpiresAt: Date.now() + 60_000,
    previewRevokedAt: null,
    previewCleanupStatus: "scheduled",
    previewCleanedAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}
