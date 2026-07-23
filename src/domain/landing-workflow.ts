import type { LandingPageIdentity } from "../repository/page-catalog";

export const LANDING_WORKFLOW_STATES = [
  "awaiting_details",
  "preparing_workspace",
  "editing",
  "validation_failed",
  "preview_ready",
  "awaiting_publish_confirmation",
  "publishing",
  "published",
  "failed",
] as const;

export type LandingWorkflowState = (typeof LANDING_WORKFLOW_STATES)[number];

export const LANDING_INTENTS = [
  "create_page",
  "update_page",
  "continue_draft",
  "inspect_status",
  "request_publish",
] as const;

export type LandingIntent = (typeof LANDING_INTENTS)[number];

export type LandingValidationStatus = "not_run" | "pending" | "passed" | "failed";

/** Public wire contract for the manage_landing MCP capability. */
export interface ManageLandingRequest {
  request: string;
  draft_id?: string;
  expected_revision?: string;
}

export interface ManageLandingValidation {
  status: LandingValidationStatus;
  checks: readonly string[];
  summary: string | null;
}

/**
 * Stable public result shape. Fields remain present when their value is not yet
 * available so callers can drive the workflow from state instead of tool names.
 */
export interface ManageLandingResult {
  state: LandingWorkflowState;
  intent: LandingIntent;
  page: LandingPageIdentity | null;
  draft_id: string | null;
  revision: string | null;
  change_summary: string;
  change_operations: readonly string[];
  validation: ManageLandingValidation;
  preview_url: string | null;
  next_action: string;
}

const ALLOWED_TRANSITIONS: Readonly<
  Record<LandingWorkflowState, readonly LandingWorkflowState[]>
> = {
  awaiting_details: ["preparing_workspace", "editing", "failed"],
  preparing_workspace: ["editing", "failed"],
  editing: ["validation_failed", "preview_ready", "failed"],
  validation_failed: ["editing", "failed"],
  preview_ready: ["editing", "awaiting_publish_confirmation", "failed"],
  awaiting_publish_confirmation: ["editing", "publishing", "failed"],
  publishing: ["published", "failed"],
  published: [],
  failed: [],
};

export function isLandingWorkflowState(value: string): value is LandingWorkflowState {
  return LANDING_WORKFLOW_STATES.some((state) => state === value);
}

export function assertLandingWorkflowTransition(
  from: LandingWorkflowState,
  to: LandingWorkflowState,
): void {
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    throw new Error(`Invalid landing workflow transition: ${from} -> ${to}`);
  }
}
