export const DEFAULT_PREVIEW_TTL_SECONDS = 24 * 60 * 60;
export const MIN_PREVIEW_TTL_SECONDS = 60;
export const MAX_PREVIEW_TTL_SECONDS = 7 * 24 * 60 * 60;

export const PREVIEW_CLEANUP_STATUSES = [
  "scheduled",
  "in_progress",
  "failed",
  "complete",
] as const;

export type PreviewCleanupStatus = (typeof PREVIEW_CLEANUP_STATUSES)[number];
export type PreviewLifecycleState = "active" | "expired" | "revoked" | "cleaned_up";

export interface PreviewLifecycleRecord {
  previewExpiresAt: number;
  previewRevokedAt: number | null;
  previewCleanupStatus: PreviewCleanupStatus;
  previewCleanedAt: number | null;
}

export function previewTtlMilliseconds(configuredSeconds: string | undefined): number {
  if (configuredSeconds === undefined || configuredSeconds.trim() === "") {
    return DEFAULT_PREVIEW_TTL_SECONDS * 1000;
  }

  const seconds = Number(configuredSeconds);
  if (
    !Number.isInteger(seconds) ||
    seconds < MIN_PREVIEW_TTL_SECONDS ||
    seconds > MAX_PREVIEW_TTL_SECONDS
  ) {
    throw new Error(
      `PREVIEW_TTL_SECONDS must be an integer between ${String(MIN_PREVIEW_TTL_SECONDS)} and ${String(MAX_PREVIEW_TTL_SECONDS)}`,
    );
  }
  return seconds * 1000;
}

export function previewLifecycleState(
  lifecycle: PreviewLifecycleRecord,
  now = Date.now(),
): PreviewLifecycleState {
  if (lifecycle.previewCleanupStatus === "complete" || lifecycle.previewCleanedAt !== null) {
    return "cleaned_up";
  }
  if (lifecycle.previewRevokedAt !== null) {
    return "revoked";
  }
  if (now >= lifecycle.previewExpiresAt) {
    return "expired";
  }
  return "active";
}

export function isPreviewCleanupStatus(value: string): value is PreviewCleanupStatus {
  return PREVIEW_CLEANUP_STATUSES.some((status) => status === value);
}

export function shouldCleanupPreview(
  lifecycle: PreviewLifecycleRecord,
  now = Date.now(),
): boolean {
  const state = previewLifecycleState(lifecycle, now);
  return state !== "active" && state !== "cleaned_up";
}

export interface PreviewCleanupResult {
  attempted: boolean;
  cleanedAt: number | null;
}

export async function runPreviewCleanup(
  lifecycle: PreviewLifecycleRecord,
  destroy: () => Promise<void>,
  now = Date.now(),
): Promise<PreviewCleanupResult> {
  if (!shouldCleanupPreview(lifecycle, now)) {
    return { attempted: false, cleanedAt: lifecycle.previewCleanedAt };
  }

  await destroy();
  return { attempted: true, cleanedAt: now };
}
