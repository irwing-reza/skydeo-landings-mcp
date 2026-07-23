export const REPOSITORY_OPERATION_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "validation_failed",
  "failed",
  "cancelled",
] as const;

export type RepositoryOperationStatus =
  (typeof REPOSITORY_OPERATION_STATUSES)[number];

export const REPOSITORY_OPERATION_PHASES = [
  "checkout",
  "install",
  "check",
  "build",
  "preview",
] as const;

export type RepositoryOperationPhase =
  (typeof REPOSITORY_OPERATION_PHASES)[number];

export type RepositoryResumeStrategy =
  | "continue_initial"
  | "reset_initial"
  | "restore_revision";

export function isRepositoryOperationStatus(
  value: string,
): value is RepositoryOperationStatus {
  return REPOSITORY_OPERATION_STATUSES.some((status) => status === value);
}

export function isRepositoryOperationPhase(
  value: string,
): value is RepositoryOperationPhase {
  return REPOSITORY_OPERATION_PHASES.some((phase) => phase === value);
}

export function repositoryResumeStrategy(
  status: RepositoryOperationStatus,
  persistedTreeSha: string | null,
): RepositoryResumeStrategy {
  if (persistedTreeSha !== null) return "restore_revision";
  return status === "running" ? "reset_initial" : "continue_initial";
}

/**
 * Route uncertain retries to one Durable Object without storing a global lookup.
 * UUID version/variant bits are set so the identifier remains accepted by the
 * public draft_id contract; the digest input is length-delimited.
 */
export async function repositoryDraftId(
  organizationId: string,
  actorId: string,
  idempotencyKey: string,
): Promise<string> {
  const material = [organizationId, actorId, idempotencyKey]
    .map((value) => `${String(value.length)}:${value}`)
    .join("|");
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material)),
  );
  const bytes = digest.slice(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
