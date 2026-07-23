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

export const REPOSITORY_EXECUTION_STEPS = [
  "checkout",
  "install",
  "base_check",
  "base_build",
  "restore",
  "edit",
  "snapshot",
  "check",
  "build",
  "preview_start",
  "preview_astro_ready",
  "preview_proxy",
  "preview_proxy_ready",
  "preview_verify",
  "preview_expose",
  "failure_restore",
] as const;

export type RepositoryExecutionStep =
  (typeof REPOSITORY_EXECUTION_STEPS)[number];

export type RepositoryProcessState =
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "killed"
  | "error";

export type RepositoryProcessAction = "dispatch" | "poll" | "complete" | "timeout";

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

export function isRepositoryExecutionStep(
  value: string,
): value is RepositoryExecutionStep {
  return REPOSITORY_EXECUTION_STEPS.some((step) => step === value);
}

export function repositoryExecutionPhase(
  step: RepositoryExecutionStep,
): RepositoryOperationPhase {
  switch (step) {
    case "checkout":
    case "restore":
    case "failure_restore":
      return "checkout";
    case "install":
      return "install";
    case "base_check":
    case "check":
    case "edit":
    case "snapshot":
      return "check";
    case "base_build":
    case "build":
      return "build";
    case "preview_start":
    case "preview_astro_ready":
    case "preview_proxy":
    case "preview_proxy_ready":
    case "preview_verify":
    case "preview_expose":
      return "preview";
  }
}

export function repositoryProcessAction(
  processId: string | null,
  processState: RepositoryProcessState | null,
  now: number,
  deadline: number | null,
): RepositoryProcessAction {
  if (deadline !== null && now >= deadline) return "timeout";
  if (processId === null || processState === null) return "dispatch";
  return processState === "starting" || processState === "running"
    ? "poll"
    : "complete";
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
