import type { DraftRecord } from "./draft";
import { classifyLandingIntent } from "./landing-intent";
import type {
  LandingWorkflowState,
  ManageLandingRequest,
  ManageLandingResult,
} from "./landing-workflow";
import { resolvePageUpdateRequest } from "./page-request";
import { previewLifecycleState } from "./preview-lifecycle";
import type { LandingRepositorySnapshot } from "../repository/page-catalog";

const NOT_RUN_VALIDATION = {
  status: "not_run" as const,
  checks: [] as const,
  summary: null,
};

/**
 * Resolve requests that do not yet have a draft. This planner is deliberately
 * side-effect free: repository workspace allocation belongs to the next layer.
 */
export function planInitialLandingRequest(
  input: ManageLandingRequest,
  snapshot: LandingRepositorySnapshot,
): ManageLandingResult {
  const intent = classifyLandingIntent(input);

  if (intent === "update_page") {
    const update = resolvePageUpdateRequest(input.request, snapshot);
    if (update.resolution.status === "resolved") {
      if (update.actionable) {
        return unavailableRepositoryResult(
          intent,
          update.resolution.page,
          `Resolved ${update.page_summary ?? update.resolution.page.name}; no changes applied.`,
        );
      }

      return {
        state: "awaiting_details",
        intent,
        page: update.resolution.page,
        draft_id: null,
        revision: null,
        change_summary: `Resolved ${update.page_summary ?? update.resolution.page.name}; no changes applied.`,
        validation: NOT_RUN_VALIDATION,
        preview_url: null,
        next_action: update.question ?? "Describe the desired page changes.",
      };
    }

    return {
      state: "awaiting_details",
      intent,
      page: null,
      draft_id: null,
      revision: null,
      change_summary: "No page was selected and no changes were applied.",
      validation: NOT_RUN_VALIDATION,
      preview_url: null,
      next_action:
        update.question ??
        "Identify the existing page and include all desired changes in one message.",
    };
  }

  if (intent === "create_page") {
    return unavailableRepositoryResult(
      intent,
      null,
      "No page was created because repository-backed workspaces are not configured.",
    );
  }

  return {
    state: "awaiting_details",
    intent,
    page: null,
    draft_id: null,
    revision: null,
    change_summary: "No draft was selected and no changes were applied.",
    validation: NOT_RUN_VALIDATION,
    preview_url: null,
    next_action: "Provide the draft_id for the workflow you want to inspect or continue.",
  };
}

export function inspectLandingDraft(draft: DraftRecord): ManageLandingResult {
  const state = workflowStateForDraft(draft);
  return {
    state,
    intent: "inspect_status",
    page: null,
    draft_id: draft.id,
    revision: draft.currentRevision,
    change_summary:
      "This is a legacy HTML-backed draft; repository-backed change records are not available.",
    validation: NOT_RUN_VALIDATION,
    preview_url: activePreviewUrl(draft),
    next_action: nextActionForDraftState(state),
  };
}

export function unavailableDraftOperation(
  input: ManageLandingRequest,
  draft: DraftRecord,
): ManageLandingResult {
  const intent = classifyLandingIntent(input);
  const operation = intent === "request_publish" ? "publishing" : "repository-backed editing";
  return {
    state: "failed",
    intent,
    page: null,
    draft_id: draft.id,
    revision: draft.currentRevision,
    change_summary: `No changes were applied; ${operation} is not configured.`,
    validation: NOT_RUN_VALIDATION,
    preview_url: activePreviewUrl(draft),
    next_action:
      "Confirm the canonical repository boundary and service credentials before retrying this operation.",
  };
}

function unavailableRepositoryResult(
  intent: ManageLandingResult["intent"],
  page: ManageLandingResult["page"],
  changeSummary: string,
): ManageLandingResult {
  return {
    state: "failed",
    intent,
    page,
    draft_id: null,
    revision: null,
    change_summary: changeSummary,
    validation: NOT_RUN_VALIDATION,
    preview_url: null,
    next_action:
      "Confirm the canonical repository boundary and service credentials before retrying this operation.",
  };
}

function workflowStateForDraft(draft: DraftRecord): LandingWorkflowState {
  if (
    draft.status === "preview_ready" &&
    previewLifecycleState(draft) !== "active"
  ) {
    return "failed";
  }

  switch (draft.status) {
    case "draft":
      return "awaiting_details";
    case "building":
      return "editing";
    case "preview_ready":
      return "preview_ready";
    case "publishing":
      return "publishing";
    case "published":
      return "published";
    case "failed":
      return "failed";
  }
}

function activePreviewUrl(draft: DraftRecord): string | null {
  return draft.status === "preview_ready" && previewLifecycleState(draft) === "active"
    ? draft.previewUrl
    : null;
}

function nextActionForDraftState(state: LandingWorkflowState): string {
  switch (state) {
    case "preview_ready":
      return "Review the preview. Repository-backed revisions and publish requests remain unavailable.";
    case "published":
      return "The workflow is complete.";
    case "publishing":
      return "Wait for publishing to complete, then inspect status again.";
    case "failed":
      return "Inspect the failure and start a new request after correcting it.";
    default:
      return "Repository-backed revisions are unavailable until the repository boundary is configured.";
  }
}
