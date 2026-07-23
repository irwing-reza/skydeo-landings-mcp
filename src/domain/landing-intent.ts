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

export interface ReplaceHeadlineChange {
  operation: "replace_headline";
  headline: string;
}

/**
 * Parse only the first deliberately narrow repository edit. Other actionable
 * requests remain awaiting_details until their own bounded operation exists.
 */
export function parseReplaceHeadlineChange(
  request: string,
): ReplaceHeadlineChange | null {
  const match = /\b(?:headline|heading)\s+(?:to|with)\s+([\s\S]+)$/iu.exec(request.trim());
  if (match?.[1] === undefined) {
    return null;
  }

  let headline = match[1].trim();
  const pairedQuote = /^(?:"([\s\S]*)"|'([\s\S]*)'|“([\s\S]*)”)$/u.exec(headline);
  if (pairedQuote !== null) {
    headline = pairedQuote[1] ?? pairedQuote[2] ?? pairedQuote[3] ?? "";
  }
  headline = headline.trim();
  if (headline.length === 0 || headline.length > 160 || /[\r\n]/u.test(headline)) {
    return null;
  }

  return { operation: "replace_headline", headline };
}
