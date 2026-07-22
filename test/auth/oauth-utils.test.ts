import { describe, expect, it } from "vitest";

import {
	addApprovedClient,
	generateCSRFProtection,
	validateCSRFToken,
} from "../../src/auth/oauth-utils";

describe("OAuth cookies", () => {
	it("uses an HTTP-compatible cookie only for loopback development", () => {
		const request = new Request("http://localhost:8787/authorize");
		const { setCookie, token } = generateCSRFProtection(request);

		expect(setCookie).toContain(`SKYDEO_DEV_CSRF_TOKEN=${token}`);
		expect(setCookie).not.toContain("; Secure");
	});

	it("keeps strict __Host cookies for production HTTPS", () => {
		const request = new Request("https://landing-mcp.skydeo.com/authorize");
		const { setCookie, token } = generateCSRFProtection(request);

		expect(setCookie).toContain(`__Host-CSRF_TOKEN=${token}`);
		expect(setCookie).toContain("; Secure");
	});

	it("validates and clears the loopback CSRF cookie", () => {
		const token = crypto.randomUUID();
		const formData = new FormData();
		formData.set("csrf_token", token);
		const request = new Request("http://127.0.0.1:8787/authorize", {
			headers: { Cookie: `SKYDEO_DEV_CSRF_TOKEN=${token}` },
		});

		expect(validateCSRFToken(formData, request).clearCookie).toBe(
			"SKYDEO_DEV_CSRF_TOKEN=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0",
		);
	});

	it("uses the same loopback policy for approved-client cookies", async () => {
		const cookie = await addApprovedClient(
			new Request("http://localhost:8787/authorize"),
			"client-id",
			"test-cookie-secret",
		);

		expect(cookie).toContain("SKYDEO_DEV_APPROVED_CLIENTS=");
		expect(cookie).not.toContain("; Secure");
	});
});
