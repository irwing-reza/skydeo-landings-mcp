import { Buffer } from "node:buffer";
import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { isLandingScope } from "./scopes";
import type { AuthContext } from "../mcp/landing-mcp";
import {
	addApprovedClient,
	createOAuthState,
	fetchUpstreamAuthToken,
	generateCSRFProtection,
	getUpstreamAuthorizeUrl,
	isClientApproved,
	OAuthError,
	renderApprovalDialog,
	validateCSRFToken,
	validateOAuthState,
} from "./oauth-utils";

type EnvWithOauth = Env & { OAUTH_PROVIDER: OAuthHelpers };

export async function handleAccessRequest(
	request: Request,
	env: Env,
): Promise<Response> {
	const oauthEnv = env as EnvWithOauth;
	const { pathname, searchParams } = new URL(request.url);

	if (request.method === "GET" && pathname === "/authorize") {
		const oauthReqInfo = await oauthEnv.OAUTH_PROVIDER.parseAuthRequest(request);
		const { clientId } = oauthReqInfo;
		if (!clientId) {
			return new Response("Invalid request", { status: 400 });
		}

		// Check if client is already approved — no approval form so no CSRF cookie to clear
		if (await isClientApproved(request, clientId, env.COOKIE_ENCRYPTION_KEY)) {
			const { stateToken, codeChallenge } = await createOAuthState(
				oauthReqInfo,
				env.OAUTH_KV,
				env.COOKIE_ENCRYPTION_KEY,
			);
			return redirectToAccess(request, env, stateToken, codeChallenge);
		}

		// Generate CSRF protection for the approval form
		const { token: csrfToken, setCookie } = generateCSRFProtection(request);

		return renderApprovalDialog(request, {
			client: await oauthEnv.OAUTH_PROVIDER.lookupClient(clientId),
			csrfToken,
			server: {
				description: "Create, review, and publish Skydeo landing pages.",
				name: "Skydeo Landing MCP",
			},
			setCookie,
			state: { oauthReqInfo },
		});
	}

	if (request.method === "POST" && pathname === "/authorize") {
		try {
			// Read form data once at top
			const formData = await request.formData();

			// Validate CSRF token and capture clearCookie to expire the one-time-use token
			const csrfResult = validateCSRFToken(formData, request);

			// Extract state from form data
			const encodedState = formData.get("state");
			if (!encodedState || typeof encodedState !== "string") {
				return new Response("Missing state in form data", { status: 400 });
			}

			let oauthReqInfo: AuthRequest;
			try {
				const state: unknown = JSON.parse(atob(encodedState));
				if (!isAuthorizationState(state)) {
					return new Response("Invalid state data", { status: 400 });
				}
				oauthReqInfo = state.oauthReqInfo;
			} catch {
				return new Response("Invalid state data", { status: 400 });
			}

			// Add client to approved list
			const approvedClientCookie = await addApprovedClient(
				request,
				oauthReqInfo.clientId,
				env.COOKIE_ENCRYPTION_KEY,
			);

			// Create OAuth state
			const { stateToken, codeChallenge } = await createOAuthState(
				oauthReqInfo,
				env.OAUTH_KV,
				env.COOKIE_ENCRYPTION_KEY,
			);

			// Build redirect headers — use Headers to support multiple Set-Cookie values
			const redirectHeaders = new Headers();
			redirectHeaders.append("Set-Cookie", approvedClientCookie);
			redirectHeaders.append("Set-Cookie", csrfResult.clearCookie);

			return redirectToAccess(request, env, stateToken, codeChallenge, redirectHeaders);
		} catch (error: unknown) {
			console.error(
				JSON.stringify({
					error: error instanceof Error ? error.message : "Unknown error",
					event: "oauth_authorize_failed",
				}),
			);
			if (error instanceof OAuthError) {
				return error.toResponse();
			}
			return new Response("Internal server error", { status: 500 });
		}
	}

	if (request.method === "GET" && pathname === "/callback") {
		// Validate OAuth state (retrieves stored data from KV)
		let oauthReqInfo: AuthRequest;
		let codeVerifier: string;

		try {
			const result = await validateOAuthState(
				request,
				env.OAUTH_KV,
				env.COOKIE_ENCRYPTION_KEY,
			);
			oauthReqInfo = result.oauthReqInfo;
			codeVerifier = result.codeVerifier;
		} catch (error: unknown) {
			if (error instanceof OAuthError) {
				return error.toResponse();
			}
			// Unexpected non-OAuth error
			return new Response("Internal server error", { status: 500 });
		}

		if (!oauthReqInfo.clientId) {
			return new Response("Invalid OAuth request data", { status: 400 });
		}
		const authorizationCode = searchParams.get("code");
		if (authorizationCode === null) {
			return new Response("Missing authorization code", { status: 400 });
		}

		// Exchange the code for an access token, including the PKCE verifier
		const [, idToken, errResponse] = await fetchUpstreamAuthToken({
			client_id: env.ACCESS_CLIENT_ID,
			client_secret: env.ACCESS_CLIENT_SECRET,
			code: authorizationCode,
			redirect_uri: new URL("/callback", request.url).href,
			upstream_url: env.ACCESS_TOKEN_URL,
			code_verifier: codeVerifier,
		});
		if (errResponse) {
			return errResponse;
		}

		const idTokenClaims = await verifyToken(env, idToken);
		const user = {
			email: idTokenClaims.email,
			// `name` belongs to the OIDC profile scope, but Cloudflare can omit it
			// when the selected upstream identity provider does not supply a name.
			// Email is verified and required below, so it is a safe display fallback.
			name: idTokenClaims.name ?? idTokenClaims.email,
			sub: idTokenClaims.sub,
		};
		const permissions = oauthReqInfo.scope.filter(isLandingScope);

		// Return back to the MCP client a new token
		const { redirectTo } = await oauthEnv.OAUTH_PROVIDER.completeAuthorization({
			metadata: {
				label: user.name,
			},
			// This will be available on this.props inside MyMCP
			props: {
				claims: user,
				organizationId: "skydeo",
				permissions,
			} satisfies AuthContext,
			request: oauthReqInfo,
			scope: permissions,
			userId: user.sub,
		});

		return Response.redirect(redirectTo, 302);
	}

	return new Response("Not Found", { status: 404 });
}

function redirectToAccess(
	request: Request,
	env: Env,
	stateToken: string,
	codeChallenge: string,
	extraHeaders: Headers = new Headers(),
): Response {
	const headers = new Headers(extraHeaders);
	headers.set(
		"location",
		getUpstreamAuthorizeUrl({
			client_id: env.ACCESS_CLIENT_ID,
			code_challenge: codeChallenge,
			redirect_uri: new URL("/callback", request.url).href,
			scope: "openid email profile",
			state: stateToken,
			upstream_url: env.ACCESS_AUTHORIZATION_URL,
		}),
	);
	return new Response(null, { headers, status: 302 });
}

/**
 * Helper to get the Access public keys from the certs endpoint
 */
async function fetchAccessPublicKey(env: Env, kid: string): Promise<CryptoKey> {
	if (!env.ACCESS_JWKS_URL) {
		throw new Error("access jwks url not provided");
	}
	// TODO: cache this
	const response = await fetch(env.ACCESS_JWKS_URL);
	if (!response.ok) {
		throw new Error("failed to fetch Access signing keys");
	}
	const keys: unknown = await response.json();
	if (!isJwks(keys)) {
		throw new Error("Access returned an invalid signing key set");
	}
	const jwk = keys.keys.find((key) => key.kid === kid);
	if (jwk === undefined) {
		throw new Error("Access signing key was not found");
	}
	const key = await crypto.subtle.importKey(
		"jwk",
		jwk,
		{
			hash: "SHA-256",
			name: "RSASSA-PKCS1-v1_5",
		},
		false,
		["verify"],
	);
	return key;
}

/**
 * Parse a JWT into its respective pieces. Does not do any validation other than form checking.
 */
interface ParsedJwt {
	data: string;
	header: Record<string, unknown>;
	payload: Record<string, unknown>;
	signature: string;
}

interface AccessClaims {
	sub: string;
	name?: string;
	email: string;
	exp: number;
	aud: string | string[];
}

function parseJWT(token: string): ParsedJwt {
	const tokenParts = token.split(".");

	if (tokenParts.length !== 3) {
		throw new Error("token must have 3 parts");
	}
	const [headerPart, payloadPart, signature] = tokenParts;
	if (headerPart === undefined || payloadPart === undefined || signature === undefined) {
		throw new Error("token must have 3 parts");
	}

	const header: unknown = JSON.parse(Buffer.from(headerPart, "base64url").toString());
	const payload: unknown = JSON.parse(Buffer.from(payloadPart, "base64url").toString());
	if (!isRecord(header) || !isRecord(payload)) {
		throw new Error("token contains invalid JSON objects");
	}

	return {
		data: `${headerPart}.${payloadPart}`,
		header,
		payload,
		signature,
	};
}

/**
 * Validates the provided token using the Access public key set
 */
async function verifyToken(env: Env, token: string): Promise<AccessClaims> {
	const jwt = parseJWT(token);
	if (typeof jwt.header.kid !== "string" || jwt.header.alg !== "RS256") {
		throw new Error("token has an unsupported signing header");
	}
	const key = await fetchAccessPublicKey(env, jwt.header.kid);

	const verified = await crypto.subtle.verify(
		"RSASSA-PKCS1-v1_5",
		key,
		Buffer.from(jwt.signature, "base64url"),
		Buffer.from(jwt.data),
	);

	if (!verified) {
		throw new Error("failed to verify token");
	}

	const claims = jwt.payload;
	if (!isAccessClaims(claims)) {
		throw new Error("token is missing required identity claims");
	}
	const now = Math.floor(Date.now() / 1000);
	// Validate expiration
	if (claims.exp < now) {
		throw new Error("expired token");
	}
	const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
	if (!audiences.includes(env.ACCESS_CLIENT_ID)) {
		throw new Error("token audience does not match the Access application");
	}

	return claims;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isAuthorizationState(value: unknown): value is { oauthReqInfo: AuthRequest } {
	return isRecord(value) && isAuthRequest(value.oauthReqInfo);
}

function isAuthRequest(value: unknown): value is AuthRequest {
	return (
		isRecord(value) &&
		typeof value.responseType === "string" &&
		typeof value.clientId === "string" &&
		typeof value.redirectUri === "string" &&
		Array.isArray(value.scope) &&
		value.scope.every((scope) => typeof scope === "string") &&
		typeof value.state === "string" &&
		(value.codeChallenge === undefined || typeof value.codeChallenge === "string") &&
		(value.codeChallengeMethod === undefined || typeof value.codeChallengeMethod === "string") &&
		(value.resource === undefined ||
			typeof value.resource === "string" ||
			(Array.isArray(value.resource) &&
				value.resource.every((resource) => typeof resource === "string")))
	);
}

function isJwks(value: unknown): value is { keys: Array<JsonWebKey & { kid: string }> } {
	return (
		isRecord(value) &&
		Array.isArray(value.keys) &&
		value.keys.every((key) => isRecord(key) && typeof key.kid === "string")
	);
}

function isAccessClaims(value: Record<string, unknown>): value is Record<string, unknown> & AccessClaims {
	return (
		typeof value.sub === "string" &&
		(value.name === undefined || typeof value.name === "string") &&
		typeof value.email === "string" &&
		typeof value.exp === "number" &&
		(typeof value.aud === "string" ||
			(Array.isArray(value.aud) && value.aud.every((audience) => typeof audience === "string")))
	);
}
