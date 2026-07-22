import type { LandingIntent, ManageLandingRequest } from "./landing-workflow";

const CREATE_PATTERN = /\b(?:create|build|design|launch|make|start|new)\b/i;
const PAGE_PATTERN = /\b(?:landing|page|site|subdomain)\b/i;
const PUBLISH_PATTERN =
  /\b(?:publish|ship|release|go live|deploy to production|request production deployment)\b/i;
const STATUS_PATTERN = /\b(?:status|progress|state|what(?:'s| is) happening)\b/i;

export function classifyLandingIntent(input: ManageLandingRequest): LandingIntent {
  const request = input.request.trim();

  if (PUBLISH_PATTERN.test(request)) {
    return "request_publish";
  }
  if (STATUS_PATTERN.test(request)) {
    return "inspect_status";
  }
  if (input.draft_id !== undefined) {
    return "continue_draft";
  }
  if (CREATE_PATTERN.test(request) && PAGE_PATTERN.test(request)) {
    return "create_page";
  }
  return "update_page";
}

const ACTIONABLE_UPDATE_PATTERN =
  /\b(?:headline|heading|copy|text|cta|button|link|seo|title|description|metadata|image|photo|illustration|layout|section|color|colour|font|replace|remove|add|rename|rewrite|change\s+\S+\s+to)\b/i;

export function hasActionablePageChange(request: string): boolean {
  return ACTIONABLE_UPDATE_PATTERN.test(request);
}
