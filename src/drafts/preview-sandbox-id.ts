const MAX_ORGANIZATION_PREFIX_LENGTH = 8;

export function previewSandboxId(organizationId: string, draftId: string): string {
  const organizationPrefix = organizationId
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, MAX_ORGANIZATION_PREFIX_LENGTH);
  const compactDraftId = draftId.toLowerCase().replaceAll("-", "");
  return `${organizationPrefix || "tenant"}-${compactDraftId}`;
}

export function draftIdFromPreviewSandboxId(sandboxId: string): string | null {
  const compactDraftId = sandboxId.slice(sandboxId.lastIndexOf("-") + 1);
  if (!/^[a-f0-9]{32}$/.test(compactDraftId)) {
    return null;
  }

  return [
    compactDraftId.slice(0, 8),
    compactDraftId.slice(8, 12),
    compactDraftId.slice(12, 16),
    compactDraftId.slice(16, 20),
    compactDraftId.slice(20),
  ].join("-");
}
