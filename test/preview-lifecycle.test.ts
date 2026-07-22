import { describe, expect, it } from "vitest";

import {
  DEFAULT_PREVIEW_TTL_SECONDS,
  previewLifecycleState,
  previewTtlMilliseconds,
  runPreviewCleanup,
  shouldCleanupPreview,
  type PreviewLifecycleRecord,
} from "../src/domain/preview-lifecycle";

const NOW = 2_000_000;

function lifecycle(overrides: Partial<PreviewLifecycleRecord> = {}): PreviewLifecycleRecord {
  return {
    previewCleanedAt: null,
    previewCleanupStatus: "scheduled",
    previewExpiresAt: NOW + 1_000,
    previewRevokedAt: null,
    ...overrides,
  };
}

describe("preview lifecycle", () => {
  it("defaults to a 24-hour TTL and accepts a bounded override", () => {
    expect(previewTtlMilliseconds(undefined)).toBe(DEFAULT_PREVIEW_TTL_SECONDS * 1000);
    expect(previewTtlMilliseconds("3600")).toBe(3_600_000);
    expect(() => previewTtlMilliseconds("0")).toThrow("PREVIEW_TTL_SECONDS");
  });

  it("reports active, expired, revoked, and cleaned-up states", () => {
    expect(previewLifecycleState(lifecycle(), NOW)).toBe("active");
    expect(previewLifecycleState(lifecycle({ previewExpiresAt: NOW }), NOW)).toBe("expired");
    expect(previewLifecycleState(lifecycle({ previewRevokedAt: NOW - 1 }), NOW)).toBe("revoked");
    expect(
      previewLifecycleState(
        lifecycle({ previewCleanedAt: NOW, previewCleanupStatus: "complete" }),
        NOW,
      ),
    ).toBe("cleaned_up");
  });

  it("only schedules cleanup for terminal previews", () => {
    expect(shouldCleanupPreview(lifecycle(), NOW)).toBe(false);
    expect(shouldCleanupPreview(lifecycle({ previewExpiresAt: NOW }), NOW)).toBe(true);
    expect(
      shouldCleanupPreview(
        lifecycle({ previewCleanedAt: NOW, previewCleanupStatus: "complete" }),
        NOW,
      ),
    ).toBe(false);
  });

  it("stops an expired container once and makes repeated cleanup safe", async () => {
    let destroyCalls = 0;
    const expired = lifecycle({ previewExpiresAt: NOW });
    const first = await runPreviewCleanup(expired, () => {
      destroyCalls += 1;
      return Promise.resolve();
    }, NOW);
    const cleaned = lifecycle({
      previewCleanedAt: first.cleanedAt,
      previewCleanupStatus: "complete",
      previewExpiresAt: NOW,
    });
    const second = await runPreviewCleanup(cleaned, () => {
      destroyCalls += 1;
      return Promise.resolve();
    }, NOW + 1);

    expect(first).toEqual({ attempted: true, cleanedAt: NOW });
    expect(second).toEqual({ attempted: false, cleanedAt: NOW });
    expect(destroyCalls).toBe(1);
  });
});
