import { describe, expect, it } from "vitest";

import { replaceHeadlineSource } from "../scripts/apply-landing-headline.mjs";
import { applyLandingEdits } from "../scripts/apply-landing-edits.mjs";
import { verifyRenderedPreview } from "../scripts/verify-repository-preview.mjs";

describe("bounded Astro headline editing", () => {
  it("preserves the h1 element, wrapper markup, and unrelated source", () => {
    const source = `---\nconst untouched = true;\n---\n<main><h1 class="hero"><span>Old headline</span></h1><p>Keep me</p></main>`;

    expect(replaceHeadlineSource(source, "Cook & serve <better>")).toBe(
      `---\nconst untouched = true;\n---\n<main><h1 class="hero"><span>Cook &amp; serve &lt;better&gt;</span></h1><p>Keep me</p></main>`,
    );
  });

  it("rejects multiple, dynamic, or multi-region h1 content", () => {
    expect(() => replaceHeadlineSource("<h1>One</h1><h1>Two</h1>", "New")).toThrow(
      "exactly one h1",
    );
    expect(() => replaceHeadlineSource("<h1>{headline}</h1>", "New")).toThrow(
      "dynamic or ambiguous",
    );
    expect(() => replaceHeadlineSource("<h1>One <span>Two</span></h1>", "New")).toThrow(
      "multiple text regions",
    );
  });

  it("rejects a no-op instead of manufacturing a revision", () => {
    expect(() => replaceHeadlineSource("<h1>Same</h1>", "Same")).toThrow(
      "already present",
    );
  });
});

describe("composable bounded Astro editing", () => {
  const page = `---\nconst untouched = true;\n---\n<Seo title="Old title" description="Old description" />\n<main>\n<section id="hero">\n<h1>Old headline</h1>\n<p data-landing-role="body-copy">Old copy</p>\n<a data-landing-role="cta" href="/old"><span>Old CTA</span></a>\n<img data-landing-role="image" src="/old.webp" alt="Old alt" />\n</section>\n<section id="proof"><p>Proof</p></section>\n</main>`;

  it("composes copy, CTA, SEO, and image changes without touching unrelated source", () => {
    const updated = applyLandingEdits(page, [
      { operation: "update_copy", value: "Better service copy" },
      { operation: "update_cta", label: "Start now", href: "/start" },
      { operation: "update_seo_metadata", title: "New title", description: "New description" },
      { operation: "replace_image", src: "/new.webp", alt: "A new product view" },
    ]);

    expect(updated).toContain("const untouched = true");
    expect(updated).toContain('title="New title" description="New description"');
    expect(updated).toContain('data-landing-role="body-copy">Better service copy</p>');
    expect(updated).toContain('href="/start"><span>Start now</span>');
    expect(updated).toContain('src="/new.webp" alt="A new product view"');
  });

  it("moves only explicitly identified sibling sections", () => {
    const updated = applyLandingEdits(page, [
      {
        operation: "apply_page_change",
        action: "move_section",
        section: "proof",
        position: "before",
        reference: "hero",
      },
    ]);
    expect(updated.indexOf('id="proof"')).toBeLessThan(updated.indexOf('id="hero"'));
  });

  it("rejects ambiguous unmarked hero targets", () => {
    const ambiguous = page.replace(
      '<p data-landing-role="body-copy">Old copy</p>',
      "<p>First</p><p>Second</p>",
    );
    expect(() =>
      applyLandingEdits(ambiguous, [{ operation: "update_copy", value: "New" }]),
    ).toThrow("exactly one hero body-copy");
  });
});

describe("rendered Astro route verification", () => {
  const html = '<html><head><title>New title</title><meta name="description" content="New description"></head><body><section id="hero"><h1>Cook &amp; serve</h1><a href="/start">Start now</a><img src="/hero.webp" alt="Dashboard"></section><section id="proof"></section></body></html>';

  it("confirms composed values and section order in rendered HTML", () => {
    expect(() =>
      verifyRenderedPreview(html, [
        { operation: "replace_headline", value: "Cook & serve" },
        { operation: "update_cta", label: "Start now", href: "/start" },
        { operation: "update_seo_metadata", title: "New title", description: "New description" },
        { operation: "replace_image", src: "/hero.webp", alt: "Dashboard" },
        { operation: "apply_page_change", action: "move_section", section: "hero", position: "before", reference: "proof" },
      ]),
    ).not.toThrow();
  });

  it("rejects a successful response that did not render the requested value", () => {
    expect(() =>
      verifyRenderedPreview(html, [{ operation: "update_copy", value: "Missing copy" }]),
    ).toThrow("expected update_copy");
  });
});
