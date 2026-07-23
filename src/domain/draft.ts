import type { PreviewCleanupStatus } from "./preview-lifecycle";

export const REPOSITORY_WORKSPACE_STATUSES = [
  "preparing",
  "ready",
  "failed",
] as const;

export type RepositoryWorkspaceStatus =
  (typeof REPOSITORY_WORKSPACE_STATUSES)[number];

export const DRAFT_STATUSES = [
  "draft",
  "building",
  "preview_ready",
  "publishing",
  "published",
  "failed",
] as const;

export type DraftStatus = (typeof DRAFT_STATUSES)[number];

export interface DraftRecord {
  id: string;
  organizationId: string;
  createdBy: string;
  hostname: string;
  status: DraftStatus;
  baseRevision: string;
  currentRevision: string;
  approvedRevision: string | null;
  previewUrl: string | null;
  productionUrl: string | null;
  html: string;
  repositoryRemoteUrl: string | null;
  repositoryReleaseRef: string | null;
  repositoryBaseSha: string | null;
  repositoryPagePath: string | null;
  repositoryWorkspaceId: string | null;
  repositoryWorkspaceStatus: RepositoryWorkspaceStatus | null;
  repositoryPreparedAt: number | null;
  repositoryTreeSha: string | null;
  repositoryChangeOperation: string | null;
  repositoryChangeSummary: string | null;
  previewExpiresAt: number;
  previewRevokedAt: number | null;
  previewCleanupStatus: PreviewCleanupStatus;
  previewCleanedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

const ALLOWED_TRANSITIONS: Readonly<Record<DraftStatus, readonly DraftStatus[]>> = {
  draft: ["building"],
  building: ["preview_ready", "failed"],
  // Publishing stays unreachable until confirmation and production safeguards exist.
  preview_ready: ["draft", "building"],
  publishing: ["published", "failed"],
  published: ["draft"],
  failed: ["draft", "building"],
};

export function isDraftStatus(value: string): value is DraftStatus {
  return DRAFT_STATUSES.some((status) => status === value);
}

export function isRepositoryWorkspaceStatus(
  value: string,
): value is RepositoryWorkspaceStatus {
  return REPOSITORY_WORKSPACE_STATUSES.some((status) => status === value);
}

export function assertDraftTransition(from: DraftStatus, to: DraftStatus): void {
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    throw new Error(`Invalid draft transition: ${from} -> ${to}`);
  }
}
