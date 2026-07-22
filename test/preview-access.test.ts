import { describe, expect, it } from "vitest";

import { requirePreviewAccess, stripPreviewCredentials } from "../src/auth/preview-access";

describe("preview credential forwarding", () => {
  it("returns an Access challenge for a signed-out user", async () => {
    const response = await requirePreviewAccess(
      new Request("https://preview.example/revision"),
      {
        PREVIEW_ACCESS_AUD: "preview-audience",
        PREVIEW_ACCESS_JWKS_URL: "https://access.example/certs",
      },
    );

    expect(response?.status).toBe(401);
    expect(response?.headers.get("www-authenticate")).toContain("Cloudflare-Access");
  });

  it("removes identity credentials before the request enters the Sandbox", () => {
    const request = new Request("https://preview.example/revision", {
      headers: {
        authorization: "Bearer mcp-token",
        "cf-access-client-id": "service-client",
        "cf-access-client-secret": "service-secret",
        "cf-access-jwt-assertion": "access-jwt",
        cookie: "CF_Authorization=access-cookie; app=value",
        "user-agent": "preview-test",
      },
    });

    const sanitized = stripPreviewCredentials(request);

    expect(sanitized.headers.get("authorization")).toBeNull();
    expect(sanitized.headers.get("cf-access-client-id")).toBeNull();
    expect(sanitized.headers.get("cf-access-client-secret")).toBeNull();
    expect(sanitized.headers.get("cf-access-jwt-assertion")).toBeNull();
    expect(sanitized.headers.get("cookie")).toBeNull();
    expect(sanitized.headers.get("user-agent")).toBe("preview-test");
  });
});
