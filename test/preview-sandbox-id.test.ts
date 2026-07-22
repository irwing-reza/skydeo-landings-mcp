import { describe, expect, it } from "vitest";

import { previewSandboxId } from "../src/drafts/preview-sandbox-id";

describe("preview sandbox IDs", () => {
  it("keeps the complete generated preview DNS label within 63 characters", () => {
    const sandboxId = previewSandboxId("skydeo", "14de4f8f-2705-4cd5-afb2-deb9ded5057e");
    const previewLabel = `4321-${sandboxId}-${"x".repeat(16)}`;

    expect(sandboxId).toBe("skydeo-14de4f8f27054cd5afb2deb9ded5057e");
    expect(previewLabel.length).toBeLessThanOrEqual(63);
  });

  it("normalizes organization characters for a DNS-safe label", () => {
    expect(previewSandboxId("Skydeo, Inc.", "ABC-123")).toBe("skydeoin-abc123");
  });
});
