import { describe, expect, it } from "vitest";

import {
  REPOSITORY_CHECKOUT_COMMAND,
  assertRepositoryPagePath,
  prepareRepositoryCheckout,
  repositoryWorkspaceConfig,
  type RepositoryCheckoutSandbox,
} from "../src/repository/workspace";
import { isRepositoryWorkspaceStatus } from "../src/domain/draft";

const BASE_SHA = "010829fa4235fb312e6706d0c8a050c2f8084499";
const CHECKOUT_TOKEN = "secret-that-must-not-enter-commands-or-results";

function configuration() {
  return repositoryWorkspaceConfig({
    REPOSITORY_BASE_SHA: BASE_SHA,
    REPOSITORY_RELEASE_REF: "refs/heads/master",
    REPOSITORY_REMOTE_URL: "git@github.com:irwing-reza/skydeo-landings.git",
  });
}

describe("repository workspace", () => {
  it("derives a credential-free HTTPS checkout URL from the canonical SSH remote", () => {
    expect(configuration()).toEqual({
      baseSha: BASE_SHA,
      checkoutUrl: "https://github.com/irwing-reza/skydeo-landings.git",
      releaseRef: "refs/heads/master",
      remoteUrl: "git@github.com:irwing-reza/skydeo-landings.git",
    });
  });

  it("rejects floating or malformed repository configuration", () => {
    expect(() =>
      repositoryWorkspaceConfig({
        REPOSITORY_BASE_SHA: "master",
        REPOSITORY_RELEASE_REF: "master",
        REPOSITORY_REMOTE_URL: "https://example.com/repository.git",
      }),
    ).toThrow("REPOSITORY_REMOTE_URL");
  });

  it("allows only repository-relative landing source paths", () => {
    expect(() => {
      assertRepositoryPagePath("src/domains/tacograph/pages/index.astro");
    }).not.toThrow();
    expect(() => {
      assertRepositoryPagePath("../wrangler.jsonc");
    }).toThrow("under src/domains");
  });

  it("passes the checkout credential only through the command environment", async () => {
    let capturedCommand = "";
    let capturedEnvironment: Record<string, string> = {};
    const sandbox: RepositoryCheckoutSandbox = {
      exec(command, options) {
        capturedCommand = command;
        capturedEnvironment = options.env;
        return Promise.resolve({ exitCode: 0, stdout: `${BASE_SHA}\n`, success: true });
      },
    };

    await prepareRepositoryCheckout(sandbox, configuration(), CHECKOUT_TOKEN);

    expect(capturedCommand).toBe(REPOSITORY_CHECKOUT_COMMAND);
    expect(capturedCommand).not.toContain(CHECKOUT_TOKEN);
    expect(capturedEnvironment).toEqual({
      REPOSITORY_BASE_SHA: BASE_SHA,
      REPOSITORY_CHECKOUT_TOKEN: CHECKOUT_TOKEN,
      REPOSITORY_CHECKOUT_URL: "https://github.com/irwing-reza/skydeo-landings.git",
    });
  });

  it("fails closed when checkout or exact-SHA verification fails", async () => {
    const failedSandbox: RepositoryCheckoutSandbox = {
      exec: () => Promise.resolve({ exitCode: 128, stdout: "", success: false }),
    };
    const wrongRevisionSandbox: RepositoryCheckoutSandbox = {
      exec: () =>
        Promise.resolve({
          exitCode: 0,
          stdout: "985a83fbffd6f2165a86095f266b5cdaae0ee551\n",
          success: true,
        }),
    };

    await expect(
      prepareRepositoryCheckout(failedSandbox, configuration(), CHECKOUT_TOKEN),
    ).rejects.toThrow("exit code 128");
    await expect(
      prepareRepositoryCheckout(wrongRevisionSandbox, configuration(), CHECKOUT_TOKEN),
    ).rejects.toThrow("configured base SHA");
  });

  it("redacts Sandbox transport errors that could contain invocation secrets", async () => {
    const sandbox: RepositoryCheckoutSandbox = {
      exec: () => Promise.reject(new Error(`transport included ${CHECKOUT_TOKEN}`)),
    };

    const failure = prepareRepositoryCheckout(
      sandbox,
      configuration(),
      CHECKOUT_TOKEN,
    );
    await expect(failure).rejects.toThrow("Repository checkout command failed");
    await expect(failure).rejects.not.toThrow(CHECKOUT_TOKEN);
  });

  it("recognizes only persisted repository workspace states", () => {
    expect(isRepositoryWorkspaceStatus("ready")).toBe(true);
    expect(isRepositoryWorkspaceStatus("publishing")).toBe(false);
  });
});
