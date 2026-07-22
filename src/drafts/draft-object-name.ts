export function draftObjectName(organizationId: string, draftId: string): string {
  return `draft:${organizationId}:${draftId}`;
}
