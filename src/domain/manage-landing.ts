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
const KNOWN_PAGE_NAMES: Readonly<Record<string, string>> = {
  tacograph: "TacoGraph",
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
        return {
          state: "awaiting_details",
          intent,
          page: update.resolution.page,
          draft_id: null,
          revision: null,
          change_summary: `Resolved ${update.page_summary ?? update.resolution.page.name}; no changes applied.`,
          change_operations: [],
          validation: NOT_RUN_VALIDATION,
          preview_url: null,
          next_action:
            "Use quoted values for headline, hero copy, CTA, SEO, or image changes; bounded layout changes can move one named section before or after another.",
        };
      }

      return {
        state: "awaiting_details",
        intent,
        page: update.resolution.page,
        draft_id: null,
        revision: null,
        change_summary: `Resolved ${update.page_summary ?? update.resolution.page.name}; no changes applied.`,
        change_operations: [],
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
      change_operations: [],
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
    change_operations: [],
    validation: NOT_RUN_VALIDATION,
    preview_url: null,
    next_action: "Provide the draft_id for the workflow you want to inspect or continue.",
  };
}

export function inspectLandingDraft(draft: DraftRecord): ManageLandingResult {
  const state = workflowStateForDraft(draft);
  const repositoryBacked = draft.repositoryTreeSha !== null;
  return {
    state,
    intent: "inspect_status",
    page: pageForDraft(draft),
    draft_id: draft.id,
    revision: publicRevision(draft),
    change_summary: repositoryBacked
      ? draft.repositoryChangeSummary ?? "The repository-backed draft is ready."
      : "This is a legacy HTML-backed draft; repository-backed change records are not available.",
    change_operations: storedChangeOperations(draft),
    validation: repositoryBacked
      ? {
          status: "passed",
          checks: ["npm run check", "npm run build", "rendered Astro route"],
          summary: "The persisted repository revision passed canonical validation and rendered route inspection.",
        }
      : NOT_RUN_VALIDATION,
    preview_url: activePreviewUrl(draft),
    next_action:
      repositoryBacked && state === "preview_ready"
        ? "Review the Astro preview or request another bounded edit batch with this draft_id and expected_revision. Publishing remains unavailable."
        : nextActionForDraftState(state),
  };
}

export function repositoryMutationResult(
  intent: ManageLandingResult["intent"],
  mutation: {
    draft: DraftRecord;
    changeSummary: string;
    operationNames: readonly string[];
    validation: ManageLandingResult["validation"];
  },
): ManageLandingResult {
  const passed = mutation.validation.status === "passed";
  return {
    state: passed ? "preview_ready" : "validation_failed",
    intent,
    page: pageForDraft(mutation.draft),
    draft_id: mutation.draft.id,
    revision: publicRevision(mutation.draft),
    change_summary: mutation.changeSummary,
    change_operations: mutation.operationNames,
    validation: mutation.validation,
    preview_url: activePreviewUrl(mutation.draft),
    next_action: passed
      ? "Review the Astro preview or request another edit batch with this draft_id and expected_revision."
      : mutation.draft.repositoryWorkspaceStatus === "failed"
        ? "Correct or narrow the requested edit batch, then start a new update. The failed disposable workspace was retired."
        : "Correct or narrow the requested edit batch, then retry with the same draft_id and expected_revision. The previous revision remains active.",
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
    change_operations: [],
    validation: NOT_RUN_VALIDATION,
    preview_url: activePreviewUrl(draft),
    next_action:
      intent === "request_publish"
        ? "Publishing remains unavailable until confirmation records and the separate PR-only publishing identity are implemented."
        : "This draft does not support repository-backed editing; start a new supported existing-page update.",
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
    change_operations: [],
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

function pageForDraft(draft: DraftRecord): ManageLandingResult["page"] {
  if (draft.repositoryPagePath === null) {
    return null;
  }
  const domain = draft.repositoryPagePath.split("/")[2] ?? draft.hostname.split(".")[0] ?? "page";
  const pageFile = draft.repositoryPagePath.split("/pages/")[1] ?? "index.astro";
  const pathname = pageFile === "index.astro"
    ? "/"
    : `/${pageFile.replace(/\.astro$/u, "")}`;
  return {
    hostname: draft.hostname,
    name:
      KNOWN_PAGE_NAMES[domain] ??
      domain
        .split("-")
        .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
        .join(" "),
    pathname,
    production_registered: true,
    production_url: `https://${draft.hostname}${pathname}`,
    source_path: draft.repositoryPagePath,
    subdomain: draft.hostname.split(".")[0] ?? domain,
  };
}

function publicRevision(draft: DraftRecord): string | null {
  return /^[a-f0-9]{64}$/u.test(draft.currentRevision)
    ? draft.currentRevision
    : null;
}

function storedChangeOperations(draft: DraftRecord): readonly string[] {
  if (draft.repositoryChangeOperation === null) return [];
  try {
    const value = JSON.parse(draft.repositoryChangeOperation) as unknown;
    if (!Array.isArray(value)) return [draft.repositoryChangeOperation];
    const entries = value as unknown[];
    if (entries.every((entry) => typeof entry === "string")) return entries;
    const operations: string[] = [];
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null || !("operation" in entry)) continue;
      const operation = (entry as { operation?: unknown }).operation;
      if (typeof operation === "string") operations.push(operation);
    }
    return operations.length === entries.length ? operations : [draft.repositoryChangeOperation];
  } catch {
    return [draft.repositoryChangeOperation];
  }
}
