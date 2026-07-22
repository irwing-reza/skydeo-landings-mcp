import { describe, expect, it } from "vitest";

import {
  buildPreviewUrl,
  isProductionPreviewHostname,
  parseLocalPreviewRoute,
  parseProductionPreviewRoute,
} from "../src/drafts/preview-url";

const REVISION = "5e8e4ef57cf5e73055be304f6eef4a403d242eb56ee88c7cdccd177d1051b48a";
const EXPOSED_HOST_LABEL =
  "4321-skydeo-14de4f8f27054cd5afb2deb9ded5057e-ovsw2plq_wq8nyfc";

describe("preview URLs", () => {
  it("returns a plain localhost path during local development", () => {
    expect(
      buildPreviewUrl(
        `http://${EXPOSED_HOST_LABEL}.localhost:8787/`,
        REVISION,
        "localhost:8787",
      ),
    ).toBe(`http://localhost:8787/__preview/${EXPOSED_HOST_LABEL}/${REVISION}`);
  });

  it("parses a local path for direct Sandbox proxying", () => {
    const localUrl = new URL(
      `http://localhost:8787/__preview/${EXPOSED_HOST_LABEL}/${REVISION}`,
    );

    expect(parseLocalPreviewRoute(localUrl)).toEqual({
      port: 4321,
      revision: REVISION,
      sandboxId: "skydeo-14de4f8f27054cd5afb2deb9ded5057e",
      token: "ovsw2plq_wq8nyfc",
    });
  });

  it("parses the preview path after Wrangler rewrites the request host", () => {
    const rewrittenUrl = new URL(
      `https://landing-mcp.skydeo.com/__preview/${EXPOSED_HOST_LABEL}/${REVISION}`,
    );

    expect(parseLocalPreviewRoute(rewrittenUrl)).toEqual({
      port: 4321,
      revision: REVISION,
      sandboxId: "skydeo-14de4f8f27054cd5afb2deb9ded5057e",
      token: "ovsw2plq_wq8nyfc",
    });
  });

  it("keeps production preview URLs in their native Sandbox format", () => {
    const exposed = `https://${EXPOSED_HOST_LABEL}.landing-mcp.skydeo.com/`;
    expect(buildPreviewUrl(exposed, REVISION, "landing-mcp.skydeo.com")).toBe(
      `${exposed}${REVISION}`,
    );
  });

  it("recognizes only one-level production Sandbox preview hostnames", () => {
    expect(
      isProductionPreviewHostname(
        `${EXPOSED_HOST_LABEL}.landing-mcp.skydeo.com`,
        "landing-mcp.skydeo.com",
      ),
    ).toBe(true);
    expect(isProductionPreviewHostname("landing-mcp.skydeo.com", "landing-mcp.skydeo.com")).toBe(
      false,
    );
    expect(
      isProductionPreviewHostname("nested.bad.landing-mcp.skydeo.com", "landing-mcp.skydeo.com"),
    ).toBe(false);
    expect(
      isProductionPreviewHostname("preview.attacker.example", "landing-mcp.skydeo.com"),
    ).toBe(false);
  });

  it("parses a production preview into its Sandbox and immutable revision", () => {
    expect(
      parseProductionPreviewRoute(
        new URL(
          `https://${EXPOSED_HOST_LABEL}.landing-mcp.skydeo.com/${REVISION}`,
        ),
        "landing-mcp.skydeo.com",
      ),
    ).toEqual({
      revision: REVISION,
      sandboxId: "skydeo-14de4f8f27054cd5afb2deb9ded5057e",
    });
  });

  it("rejects malformed production preview paths", () => {
    expect(
      parseProductionPreviewRoute(
        new URL(
          `https://${EXPOSED_HOST_LABEL}.landing-mcp.skydeo.com/${REVISION}/extra`,
        ),
        "landing-mcp.skydeo.com",
      ),
    ).toBeNull();
  });
});
