import { describe, expect, it } from "vitest";

import { requireActivePreviewRoute } from "../src/drafts/preview-authorization";

const ROUTE = {
  revision: "5e8e4ef57cf5e73055be304f6eef4a403d242eb56ee88c7cdccd177d1051b48a",
  sandboxId: "skydeo-14de4f8f27054cd5afb2deb9ded5057e",
};

describe("preview lifecycle authorization", () => {
  it("allows an active authenticated preview to reach the proxy", async () => {
    const response = await requireActivePreviewRoute("skydeo", ROUTE, () =>
      Promise.resolve({ allowed: true, state: "active" }),
    );
    expect(response).toBeNull();
  });

  it.each(["expired", "revoked", "cleaned_up"] as const)(
    "fails closed for a %s preview",
    async (state) => {
      const response = await requireActivePreviewRoute("skydeo", ROUTE, () =>
        Promise.resolve({ allowed: false, state }),
      );
      expect(response?.status).toBe(410);
      await expect(response?.json()).resolves.toEqual({
        error: "preview_unavailable",
        state,
      });
    },
  );

  it("does not reveal a draft for an invalid Sandbox mapping", async () => {
    const response = await requireActivePreviewRoute(
      "another-organization",
      ROUTE,
      () => Promise.resolve({ allowed: true, state: "active" }),
    );
    expect(response?.status).toBe(404);
  });

  it("hides an active preview when its immutable revision does not match", async () => {
    const response = await requireActivePreviewRoute("skydeo", ROUTE, () =>
      Promise.resolve({ allowed: false, state: "active" }),
    );
    expect(response?.status).toBe(404);
  });

  it("allows active Astro asset requests without a revision query", async () => {
    let observedRevision: string | null | undefined;
    const response = await requireActivePreviewRoute(
      "skydeo",
      { ...ROUTE, revision: null },
      (_draftId, revision) => {
        observedRevision = revision;
        return Promise.resolve({ allowed: true, state: "active" });
      },
    );
    expect(response).toBeNull();
    expect(observedRevision).toBeNull();
  });
});
