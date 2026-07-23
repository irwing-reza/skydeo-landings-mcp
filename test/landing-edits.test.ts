import { describe, expect, it } from "vitest";

import {
  parseLandingEditBatch,
  summarizeLandingEdits,
} from "../src/domain/landing-edits";

describe("landing edit batches", () => {
  it("parses several quoted operations into one atomic batch", () => {
    expect(
      parseLandingEditBatch(
        'Update TacoGraph: headline to "Cook smarter"; hero copy to "Plan every service"; CTA label to "Start free"; CTA URL to "/signup"; SEO title to "TacoGraph service planning"; SEO description to "Plan and run every service."; image source to "/images/hero.webp"; image alt to "TacoGraph dashboard"',
      ),
    ).toEqual({
      status: "parsed",
      operations: [
        { operation: "replace_headline", value: "Cook smarter" },
        { operation: "update_copy", value: "Plan every service" },
        { operation: "update_cta", label: "Start free", href: "/signup" },
        {
          operation: "update_seo_metadata",
          title: "TacoGraph service planning",
          description: "Plan and run every service.",
        },
        {
          operation: "replace_image",
          src: "/images/hero.webp",
          alt: "TacoGraph dashboard",
        },
      ],
    });
  });

  it("parses a bounded named-section move", () => {
    expect(
      parseLandingEditBatch('Move section "proof" before section "pricing"'),
    ).toEqual({
      status: "parsed",
      operations: [
        {
          operation: "apply_page_change",
          action: "move_section",
          section: "proof",
          position: "before",
          reference: "pricing",
        },
      ],
    });
  });

  it("rejects unsafe or underspecified image and CTA requests", () => {
    expect(parseLandingEditBatch('CTA URL to "javascript:alert(1)"')).toMatchObject({
      status: "needs_details",
    });
    expect(parseLandingEditBatch('image alt to "Dashboard"')).toEqual({
      status: "needs_details",
      message: "An image update requires an explicit image source as well as optional alt text.",
    });
  });

  it("summarizes composed operations", () => {
    expect(
      summarizeLandingEdits("tacograph.skydeo.com", [
        { operation: "update_copy", value: "New copy" },
        { operation: "update_cta", label: "Start" },
      ]),
    ).toBe("Updated hero body copy and CTA on tacograph.skydeo.com.");
  });
});
