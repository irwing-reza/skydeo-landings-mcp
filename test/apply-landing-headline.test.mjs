import { describe, expect, it } from "vitest";

import { replaceHeadlineSource } from "../scripts/apply-landing-headline.mjs";

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
