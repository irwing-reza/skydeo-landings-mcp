import type { PreviewAuthorization } from "./draft-coordinator";
import {
  draftIdFromPreviewSandboxId,
  previewSandboxId,
} from "./preview-sandbox-id";
import type { ProductionPreviewRoute } from "./preview-url";

export type PreviewAuthorizationResolver = (
  draftId: string,
  revision: string,
) => Promise<PreviewAuthorization>;

export async function requireActivePreviewRoute(
  organizationId: string,
  route: ProductionPreviewRoute,
  authorize: PreviewAuthorizationResolver,
): Promise<Response | null> {
  const draftId = draftIdFromPreviewSandboxId(route.sandboxId);
  if (
    draftId === null ||
    previewSandboxId(organizationId, draftId) !== route.sandboxId
  ) {
    return new Response("Preview not found", { status: 404 });
  }

  try {
    const authorization = await authorize(draftId, route.revision);
    if (authorization.allowed) {
      return null;
    }
    return Response.json(
      {
        error: "preview_unavailable",
        state: authorization.state,
      },
      {
        headers: { "cache-control": "no-store" },
        status: 410,
      },
    );
  } catch {
    return new Response("Preview not found", { status: 404 });
  }
}
