import { describe, expect, it } from "vitest";

import { classifyLandingIntent, hasActionablePageChange } from "../src/domain/landing-intent";
import {
  inspectLandingDraft,
  planInitialLandingRequest,
  unavailableDraftOperation,
} from "../src/domain/manage-landing";
import {
  assertLandingWorkflowTransition,
  isLandingWorkflowState,
  type ManageLandingResult,
} from "../src/domain/landing-workflow";
import { LOCAL_CANDIDATE_LANDING_SNAPSHOT } from "../src/repository/page-catalog";
import type { DraftRecord } from "../src/domain/draft";

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

  it("fails a concrete update closed before repository configuration", () => {
    const result = planInitialLandingRequest(
      { request: "Change the TacoGraph headline to Cook smarter" },
      LOCAL_CANDIDATE_LANDING_SNAPSHOT,
    );

    expect(result).toMatchObject({
      state: "failed",
      intent: "update_page",
      draft_id: null,
      page: { name: "TacoGraph" },
    });
    expect(result.next_action).toContain("canonical repository boundary");
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
    previewExpiresAt: Date.now() + 60_000,
    previewRevokedAt: null,
    previewCleanupStatus: "scheduled",
    previewCleanedAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}
