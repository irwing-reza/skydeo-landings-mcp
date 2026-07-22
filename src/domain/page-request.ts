import { hasActionablePageChange } from "./landing-intent";
import {
  resolveLandingPage,
  type LandingPageIdentity,
  type LandingRepositorySnapshot,
  type PageResolution,
} from "../repository/page-catalog";

export interface ResolvedPageUpdateRequest {
  resolution: PageResolution;
  actionable: boolean;
  page_summary: string | null;
  question: string | null;
}

/** Resolve an initial update request without allocating any draft resources. */
export function resolvePageUpdateRequest(
  request: string,
  snapshot: LandingRepositorySnapshot,
): ResolvedPageUpdateRequest {
  const resolution = resolveLandingPage(request, snapshot);
  if (resolution.status === "ambiguous") {
    const choices = resolution.pages.map(summarizePage).join("; ");
    return {
      resolution,
      actionable: false,
      page_summary: null,
      question: `Which page should be updated, and what changes should be made? Matches: ${choices}`,
    };
  }
  if (resolution.status === "not_found") {
    return {
      resolution,
      actionable: false,
      page_summary: null,
      question:
        "Which existing page should be updated, and what changes should be made? Include its production URL, hostname, name, or source path.",
    };
  }

  const actionable = hasActionablePageChange(request);
  return {
    resolution,
    actionable,
    page_summary: summarizePage(resolution.page),
    question: actionable
      ? null
      : `What would you like to change on ${resolution.page.name}? Include all desired copy, CTA, SEO, image, or layout changes in one message.`,
  };
}

function summarizePage(page: LandingPageIdentity): string {
  const route = page.production_url ?? `${page.hostname}${page.pathname} (not registered)`;
  return `${page.name}: ${route} -> ${page.source_path}`;
}
