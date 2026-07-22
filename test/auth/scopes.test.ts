import { describe, expect, it } from "vitest";

import { isLandingScope, LANDING_SCOPES } from "../../src/auth/scopes";

describe("landing OAuth scopes", () => {
  it("recognizes every configured scope", () => {
    for (const scope of LANDING_SCOPES) {
      expect(isLandingScope(scope)).toBe(true);
    }
  });

  it("rejects unconfigured scopes", () => {
    expect(isLandingScope("admin")).toBe(false);
  });
});
