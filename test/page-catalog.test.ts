import { describe, expect, it } from "vitest";

import { resolvePageUpdateRequest } from "../src/domain/page-request";
import {
  discoverLandingPages,
  findOccupiedRoute,
  LOCAL_CANDIDATE_LANDING_SNAPSHOT,
  resolveLandingPage,
  type LandingRepositorySnapshot,
} from "../src/repository/page-catalog";

describe("landing page discovery", () => {
  it("derives routes deterministically and marks only registered production pages", () => {
    const pages = discoverLandingPages(LOCAL_CANDIDATE_LANDING_SNAPSHOT);
    const tacoGraph = pages.find((page) => page.subdomain === "tacograph");
    const details = pages.find((page) => page.source_path.endsWith("details.astro"));

    expect(tacoGraph).toMatchObject({
      name: "TacoGraph",
      pathname: "/",
      production_registered: true,
      production_url: "https://tacograph.skydeo.com/",
      source_path: "src/domains/tacograph/pages/index.astro",
    });
    expect(details).toMatchObject({
      pathname: "/details",
      production_registered: false,
      production_url: null,
    });
  });

  it.each([
    "TacoGraph",
    "tacograph",
    "https://tacograph.skydeo.com/",
    "Please update tacograph.skydeo.com",
    "src/domains/tacograph/pages/index.astro",
  ])("resolves TacoGraph from %s", (reference) => {
    const resolution = resolveLandingPage(reference, LOCAL_CANDIDATE_LANDING_SNAPSHOT);
    expect(resolution.status).toBe("resolved");
    if (resolution.status === "resolved") {
      expect(resolution.page.source_path).toBe("src/domains/tacograph/pages/index.astro");
    }
  });

  it("returns all best-priority matches instead of silently choosing", () => {
    const snapshot: LandingRepositorySnapshot = {
      baseDomain: "skydeo.com",
      registeredHostnames: ["somegraph.skydeo.com"],
      sourcePaths: [
        "src/domains/somegraph/pages/index.astro",
        "src/domains/somegraph/pages/details.astro",
      ],
    };
    const resolution = resolveLandingPage("Update somegraph.skydeo.com", snapshot);

    expect(resolution.status).toBe("ambiguous");
    if (resolution.status === "ambiguous") {
      expect(resolution.pages.map((page) => page.pathname)).toEqual(["/details", "/"]);
    }
  });

  it("summarizes a uniquely resolved vague update and asks one consolidated question", () => {
    const result = resolvePageUpdateRequest(
      "I want to update the TacoGraph page",
      LOCAL_CANDIDATE_LANDING_SNAPSHOT,
    );

    expect(result.resolution.status).toBe("resolved");
    expect(result.actionable).toBe(false);
    expect(result.page_summary).toContain("https://tacograph.skydeo.com/");
    expect(result.page_summary).toContain("src/domains/tacograph/pages/index.astro");
    expect(result.question).toContain("all desired");
  });

  it("lets a concrete resolved update proceed without another question", () => {
    const result = resolvePageUpdateRequest(
      "Update TacoGraph: replace the headline with Cook smarter",
      LOCAL_CANDIDATE_LANDING_SNAPSHOT,
    );

    expect(result.resolution.status).toBe("resolved");
    expect(result.actionable).toBe(true);
    expect(result.question).toBeNull();
  });

  it("detects occupied routes even when they are not registered in production", () => {
    const occupied = findOccupiedRoute(
      "somegraph.skydeo.com",
      "/details/",
      LOCAL_CANDIDATE_LANDING_SNAPSHOT,
    );
    expect(occupied?.source_path).toBe("src/domains/somegraph/pages/details.astro");
  });
});
