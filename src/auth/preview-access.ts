import { verifyAccessJwt } from "./access-jwt";

const ACCESS_ASSERTION_HEADER = "cf-access-jwt-assertion";
const PREVIEW_CREDENTIAL_HEADERS = [
  ACCESS_ASSERTION_HEADER,
  "authorization",
  "cf-access-client-id",
  "cf-access-client-secret",
  "cookie",
] as const;

interface PreviewAccessEnv {
  PREVIEW_ACCESS_AUD: string;
  PREVIEW_ACCESS_JWKS_URL: string;
}

export async function requirePreviewAccess(
  request: Request,
  env: PreviewAccessEnv,
): Promise<Response | null> {
  const token = request.headers.get(ACCESS_ASSERTION_HEADER);
  if (token === null) {
    return unauthorizedPreview("missing_access_assertion");
  }

  try {
    await verifyAccessJwt(token, {
      audience: env.PREVIEW_ACCESS_AUD,
      jwksUrl: env.PREVIEW_ACCESS_JWKS_URL,
    });
    return null;
  } catch (error: unknown) {
    console.warn(
      JSON.stringify({
        event: "preview_access_denied",
        reason: error instanceof Error ? error.message : "invalid_access_assertion",
      }),
    );
    return unauthorizedPreview("invalid_access_assertion");
  }
}

export function stripPreviewCredentials(request: Request): Request {
  const headers = new Headers(request.headers);
  for (const header of PREVIEW_CREDENTIAL_HEADERS) {
    headers.delete(header);
  }
  return new Request(request, { headers });
}

function unauthorizedPreview(error: string): Response {
  return Response.json(
    {
      error,
      message: "Authenticate through Cloudflare Access to view this preview.",
    },
    {
      headers: {
        "cache-control": "no-store",
        "www-authenticate": 'Cloudflare-Access realm="Skydeo landing previews"',
      },
      status: 401,
    },
  );
}
