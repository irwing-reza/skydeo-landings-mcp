const MAX_ORGANIZATION_PREFIX_LENGTH = 8;

export function previewSandboxId(organizationId: string, draftId: string): string {
  const organizationPrefix = organizationId
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, MAX_ORGANIZATION_PREFIX_LENGTH);
  const compactDraftId = draftId.toLowerCase().replaceAll("-", "");
  return `${organizationPrefix || "tenant"}-${compactDraftId}`;
}
