import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { getSandbox, proxyToSandbox } from "@cloudflare/sandbox";
import { handleAccessRequest } from "./auth/access-handler";
import { requirePreviewAccess, stripPreviewCredentials } from "./auth/preview-access";
import { LANDING_SCOPES } from "./auth/scopes";
import { draftObjectName } from "./drafts/draft-object-name";
import { requireActivePreviewRoute } from "./drafts/preview-authorization";
import {
  isProductionPreviewHostname,
  parseLocalPreviewRoute,
  parseProductionPreviewRoute,
  type ProductionPreviewRoute,
} from "./drafts/preview-url";
import { LandingMcp } from "./mcp/landing-mcp";

export { Sandbox } from "@cloudflare/sandbox";
export { DraftCoordinator } from "./drafts/draft-coordinator";
export { LandingMcp } from "./mcp/landing-mcp";

const localMcpHandler = LandingMcp.serve("/mcp", { binding: "LANDING_MCP" });
const accessOauthProvider = new OAuthProvider<Env>({
  apiHandler: LandingMcp.serve("/mcp", { binding: "LANDING_MCP" }),
  apiRoute: "/mcp",
  authorizeEndpoint: "/authorize",
  clientRegistrationEndpoint: "/register",
  defaultHandler: { fetch: handleAccessRequest },
  tokenEndpoint: "/token",
  scopesSupported: [...LANDING_SCOPES],
  allowImplicitFlow: false,
  allowPlainPKCE: false,
  resourceMetadata: {
    resource_name: "Skydeo Landing MCP",
    scopes_supported: [...LANDING_SCOPES],
  },
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const authMode: string = env.MCP_AUTH_MODE;

    const localPreviewRoute =
      authMode === "local" ? parseLocalPreviewRoute(url) : null;
    if (localPreviewRoute !== null) {
      const lifecycleFailure = await requireActivePreview(env, localPreviewRoute);
      return lifecycleFailure ?? proxyLocalPreview(request, env, localPreviewRoute);
    }

    if (isProductionPreviewHostname(url.hostname, env.PREVIEW_HOSTNAME)) {
      if (authMode !== "access") {
        return Response.json(
          {
            error: "preview_auth_not_configured",
            message: "Preview delivery remains closed until production authentication is enabled.",
          },
          { headers: { "cache-control": "no-store" }, status: 503 },
        );
      }

      const accessFailure = await requirePreviewAccess(request, env);
      if (accessFailure !== null) {
        return accessFailure;
      }

      const previewRoute = parseProductionPreviewRoute(url, env.PREVIEW_HOSTNAME);
      if (previewRoute === null) {
        return new Response("Preview not found", { status: 404 });
      }
      const lifecycleFailure = await requireActivePreview(env, previewRoute);
      if (lifecycleFailure !== null) {
        return lifecycleFailure;
      }

      const sandboxPreview = await proxyToSandbox(stripPreviewCredentials(request), env);
      return sandboxPreview ?? new Response("Preview not found", { status: 404 });
    }

    if (request.method === "GET" && url.pathname === "/healthz") {
      return Response.json({ service: "skydeo-landing-mcp", status: "ok" });
    }

    if (authMode === "local") {
      return url.pathname.startsWith("/mcp")
        ? localMcpHandler.fetch(request, env, ctx)
        : new Response("Not found", { status: 404 });
    }

    if (authMode === "access") {
      return accessOauthProvider.fetch(request, env, ctx);
    }

    if (isOAuthPath(url.pathname)) {
      return Response.json(
        {
          error: "mcp_auth_not_configured",
          message: "The MCP endpoint remains closed until Cloudflare Access is configured.",
        },
        { status: 503 },
      );
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

interface LocalPreviewRoute {
  port: number;
  revision: string | null;
  sandboxId: string;
  token: string;
}

async function requireActivePreview(
  env: Env,
  route: ProductionPreviewRoute,
): Promise<Response | null> {
  return requireActivePreviewRoute(
    env.ORGANIZATION_ID,
    route,
    (draftId, revision) =>
      env.DRAFTS.getByName(
        draftObjectName(env.ORGANIZATION_ID, draftId),
      ).authorizePreview(env.ORGANIZATION_ID, revision),
  );
}

async function proxyLocalPreview(
  request: Request,
  env: Env,
  route: LocalPreviewRoute,
): Promise<Response> {
  const sandbox = getSandbox(env.Sandbox, route.sandboxId, { normalizeId: true });
  const headers = new Headers(request.headers);
  headers.set("x-sandbox-preview-proxy", "1");
  headers.set("x-sandbox-preview-port", route.port.toString());
  headers.set("x-sandbox-preview-token", route.token);
  headers.set("x-sandbox-preview-sandbox-id", route.sandboxId);

  const previewUrl = new URL(request.url);
  const forwardedPath = previewUrl.pathname
    .slice("/__preview/".length)
    .split("/")
    .slice(1)
    .join("/");
  previewUrl.pathname = `/${forwardedPath}`;
  return sandbox.fetch(new Request(previewUrl, { headers, method: request.method }));
}

function isOAuthPath(pathname: string): boolean {
  return (
    pathname.startsWith("/mcp") ||
    pathname === "/authorize" ||
    pathname === "/callback" ||
    pathname === "/register" ||
    pathname === "/token" ||
    pathname.startsWith("/.well-known/")
  );
}
