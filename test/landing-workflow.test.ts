import { describe, expect, it } from "vitest";

import { classifyLandingIntent, hasActionablePageChange } from "../src/domain/landing-intent";
import {
  assertLandingWorkflowTransition,
  isLandingWorkflowState,
  type ManageLandingResult,
} from "../src/domain/landing-workflow";

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
});
