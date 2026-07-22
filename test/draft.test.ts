import { describe, expect, it } from "vitest";

import { assertDraftTransition, isDraftStatus } from "../src/domain/draft";

describe("draft state machine", () => {
  it("allows the preview cycle", () => {
    expect(() => {
      assertDraftTransition("draft", "building");
    }).not.toThrow();
    expect(() => {
      assertDraftTransition("building", "preview_ready");
    }).not.toThrow();
    expect(() => {
      assertDraftTransition("preview_ready", "draft");
    }).not.toThrow();
  });

  it("requires preview readiness before publishing", () => {
    expect(() => {
      assertDraftTransition("draft", "publishing");
    }).toThrow("Invalid draft transition: draft -> publishing");
  });

  it("keeps publishing unavailable even for a preview-ready draft", () => {
    expect(() => {
      assertDraftTransition("preview_ready", "publishing");
    }).toThrow("Invalid draft transition: preview_ready -> publishing");
  });

  it("rejects unknown persisted statuses", () => {
    expect(isDraftStatus("preview_ready")).toBe(true);
    expect(isDraftStatus("deleted")).toBe(false);
  });
});
