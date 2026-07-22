import { Buffer } from "node:buffer";

export interface AccessJwtClaims extends Record<string, unknown> {
  aud: string | string[];
  email?: string;
  exp: number;
  name?: string;
  nbf?: number;
  sub: string;
}

interface AccessJwk extends JsonWebKey {
  kid: string;
}

interface VerifyAccessJwtOptions {
  audience: string;
  jwksUrl: string;
  now?: number;
}

/**
 * Verify a Cloudflare Access JWT at the Worker boundary. Access still enforces
 * the policy at the edge; this check prevents a routing or policy mistake from
 * turning a Sandbox preview into an unauthenticated origin.
 */
export async function verifyAccessJwt(
  token: string,
  options: VerifyAccessJwtOptions,
): Promise<AccessJwtClaims> {
  const jwt = parseJwt(token);
  if (typeof jwt.header.kid !== "string" || jwt.header.alg !== "RS256") {
    throw new Error("Access token has an unsupported signing header");
  }

  const key = await fetchAccessPublicKey(options.jwksUrl, jwt.header.kid);
  const verified = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    Buffer.from(jwt.signature, "base64url"),
    Buffer.from(jwt.data),
  );
  if (!verified) {
    throw new Error("Access token signature is invalid");
  }

  if (!isAccessJwtClaims(jwt.payload)) {
    throw new Error("Access token is missing required claims");
  }

  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (jwt.payload.exp <= now) {
    throw new Error("Access token has expired");
  }
  if (jwt.payload.nbf !== undefined && jwt.payload.nbf > now) {
    throw new Error("Access token is not active yet");
  }

  const audiences = Array.isArray(jwt.payload.aud) ? jwt.payload.aud : [jwt.payload.aud];
  if (!audiences.includes(options.audience)) {
    throw new Error("Access token audience does not match the application");
  }

  return jwt.payload;
}

interface ParsedJwt {
  data: string;
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signature: string;
}

function parseJwt(token: string): ParsedJwt {
  const tokenParts = token.split(".");
  if (tokenParts.length !== 3) {
    throw new Error("Access token must have three parts");
  }

  const [headerPart, payloadPart, signature] = tokenParts;
  if (headerPart === undefined || payloadPart === undefined || signature === undefined) {
    throw new Error("Access token must have three parts");
  }

  let header: unknown;
  let payload: unknown;
  try {
    header = JSON.parse(Buffer.from(headerPart, "base64url").toString());
    payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString());
  } catch {
    throw new Error("Access token contains invalid JSON");
  }

  if (!isRecord(header) || !isRecord(payload)) {
    throw new Error("Access token contains invalid JSON objects");
  }

  return {
    data: `${headerPart}.${payloadPart}`,
    header,
    payload,
    signature,
  };
}

async function fetchAccessPublicKey(jwksUrl: string, kid: string): Promise<CryptoKey> {
  const response = await fetch(jwksUrl);
  if (!response.ok) {
    throw new Error("Failed to fetch Access signing keys");
  }

  const keys: unknown = await response.json();
  if (!isJwks(keys)) {
    throw new Error("Access returned an invalid signing key set");
  }

  const jwk = keys.keys.find((candidate) => candidate.kid === kid);
  if (jwk === undefined) {
    throw new Error("Access signing key was not found");
  }

  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { hash: "SHA-256", name: "RSASSA-PKCS1-v1_5" },
    false,
    ["verify"],
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isJwks(value: unknown): value is { keys: AccessJwk[] } {
  return (
    isRecord(value) &&
    Array.isArray(value.keys) &&
    value.keys.every((key) => isRecord(key) && typeof key.kid === "string")
  );
}

function isAccessJwtClaims(value: Record<string, unknown>): value is AccessJwtClaims {
  return (
    typeof value.sub === "string" &&
    typeof value.exp === "number" &&
    (value.nbf === undefined || typeof value.nbf === "number") &&
    (value.name === undefined || typeof value.name === "string") &&
    (value.email === undefined || typeof value.email === "string") &&
    (typeof value.aud === "string" ||
      (Array.isArray(value.aud) && value.aud.every((audience) => typeof audience === "string")))
  );
}
