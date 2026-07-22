import { generateKeyPairSync, sign } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { verifyAccessJwt } from "../src/auth/access-jwt";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = publicKey.export({ format: "jwk" });
const KID = "test-access-key";
const NOW = 1_800_000_000;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Access JWT verification", () => {
  it("accepts a signed, active token for the configured audience", async () => {
    stubJwks();
    const claims = await verifyAccessJwt(
      makeToken({ aud: ["preview-aud", "other-aud"], exp: NOW + 60, sub: "actor-1" }),
      { audience: "preview-aud", jwksUrl: "https://access.example/certs", now: NOW },
    );

    expect(claims.sub).toBe("actor-1");
  });

  it("rejects expired, future, and wrong-audience tokens", async () => {
    stubJwks();
    await expect(
      verifyAccessJwt(makeToken({ aud: "preview-aud", exp: NOW, sub: "actor-1" }), {
        audience: "preview-aud",
        jwksUrl: "https://access.example/certs",
        now: NOW,
      }),
    ).rejects.toThrow("expired");
    await expect(
      verifyAccessJwt(
        makeToken({ aud: "preview-aud", exp: NOW + 60, nbf: NOW + 1, sub: "actor-1" }),
        { audience: "preview-aud", jwksUrl: "https://access.example/certs", now: NOW },
      ),
    ).rejects.toThrow("not active");
    await expect(
      verifyAccessJwt(makeToken({ aud: "wrong-aud", exp: NOW + 60, sub: "actor-1" }), {
        audience: "preview-aud",
        jwksUrl: "https://access.example/certs",
        now: NOW,
      }),
    ).rejects.toThrow("audience");
  });
});

function stubJwks(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        Response.json({
          keys: [{ ...publicJwk, alg: "RS256", kid: KID, use: "sig" }],
        }),
      ),
    ),
  );
}

function makeToken(payload: Record<string, unknown>): string {
  const header = encode({ alg: "RS256", kid: KID, typ: "JWT" });
  const body = encode(payload);
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${body}`), privateKey).toString(
    "base64url",
  );
  return `${header}.${body}.${signature}`;
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
