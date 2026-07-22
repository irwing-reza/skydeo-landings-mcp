import { describe, expect, it } from "vitest";

import { stripPreviewCredentials } from "../src/auth/preview-access";

describe("preview credential forwarding", () => {
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
