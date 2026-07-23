import { describe, expect, it } from "vitest";

import {
  REPOSITORY_CHECKOUT_COMMAND,
  REPOSITORY_BUILD_COMMAND,
  REPOSITORY_CHECK_COMMAND,
  REPOSITORY_INSTALL_COMMAND,
  REPOSITORY_HEADLINE_COMMAND,
  REPOSITORY_TREE_COMMAND,
  assertRepositoryPagePath,
  boundedRedactedDiagnostic,
  installAndValidateRepository,
  prepareRepositoryCheckout,
  replaceRepositoryHeadline,
  repositoryTreeRevision,
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
        capturedEnvironment = options.env ?? {};
        return Promise.resolve({
          exitCode: 0,
          stderr: "",
          stdout: `${BASE_SHA}\n`,
          success: true,
        });
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
      exec: () =>
        Promise.resolve({ exitCode: 128, stderr: "checkout failed", stdout: "", success: false }),
    };
    const wrongRevisionSandbox: RepositoryCheckoutSandbox = {
      exec: () =>
        Promise.resolve({
          exitCode: 0,
          stderr: "",
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

  it("installs deterministically and runs the canonical checks in order", async () => {
    const invocations: Array<{
      command: string;
      options: { cwd?: string; env?: Record<string, string>; timeout: number };
    }> = [];
    const sandbox: RepositoryCheckoutSandbox = {
      exec(command, options) {
        invocations.push({ command, options });
        return Promise.resolve({ exitCode: 0, stderr: "", stdout: "ok", success: true });
      },
    };

    await expect(installAndValidateRepository(sandbox)).resolves.toEqual({
      install: "passed",
      checks: [REPOSITORY_CHECK_COMMAND, REPOSITORY_BUILD_COMMAND],
    });
    expect(invocations.map(({ command }) => command)).toEqual([
      REPOSITORY_INSTALL_COMMAND,
      REPOSITORY_CHECK_COMMAND,
      REPOSITORY_BUILD_COMMAND,
    ]);
    for (const { options } of invocations) {
      expect(options.cwd).toBe("/workspace/repository");
      expect(options.timeout).toBe(300_000);
      expect(options.env?.CI).toBe("true");
      expect(options.env).not.toHaveProperty("REPOSITORY_CHECKOUT_TOKEN");
    }
  });

  it("stops after the first validation failure with bounded redacted diagnostics", async () => {
    const commands: string[] = [];
    const sandbox: RepositoryCheckoutSandbox = {
      exec(command) {
        commands.push(command);
        if (command === REPOSITORY_CHECK_COMMAND) {
          return Promise.resolve({
            exitCode: 2,
            stderr: `password=hunter2\n${"x".repeat(5_000)}`,
            stdout: "token: exposed-value",
            success: false,
          });
        }
        return Promise.resolve({ exitCode: 0, stderr: "", stdout: "ok", success: true });
      },
    };

    const failure = installAndValidateRepository(sandbox);
    await expect(failure).rejects.toMatchObject({ exitCode: 2, step: "check" });
    await expect(failure).rejects.not.toThrow("hunter2");
    await expect(failure).rejects.not.toThrow("exposed-value");
    await expect(failure).rejects.toThrow("[REDACTED]");
    await expect(failure).rejects.toThrow("[truncated]");
    expect(commands).toEqual([REPOSITORY_INSTALL_COMMAND, REPOSITORY_CHECK_COMMAND]);
  });

  it("redacts credential URLs and caps diagnostics", () => {
    const diagnostic = boundedRedactedDiagnostic(
      `fetch https://user:credential@example.com/repository\nAuthorization: Bearer abcdef\n` +
        `github_pat_sensitivevalue\n${"a".repeat(5_000)}`,
    );

    expect(diagnostic).not.toContain("credential");
    expect(diagnostic).not.toContain("abcdef");
    expect(diagnostic).not.toContain("sensitivevalue");
    expect(diagnostic).toContain("https://[REDACTED]@example.com");
    expect(diagnostic.length).toBeLessThanOrEqual(4_109);
  });

  it("does not serialize Sandbox transport failures into validation errors", async () => {
    const sandbox: RepositoryCheckoutSandbox = {
      exec: () => Promise.reject(new Error(`transport included ${CHECKOUT_TOKEN}`)),
    };

    const failure = installAndValidateRepository(sandbox);
    await expect(failure).rejects.toMatchObject({ exitCode: null, step: "install" });
    await expect(failure).rejects.toThrow("Sandbox command failed");
    await expect(failure).rejects.not.toThrow(CHECKOUT_TOKEN);
  });

  it("applies a headline through fixed commands and snapshots the repository tree", async () => {
    const treeSha = "b".repeat(40);
    const invocations: Array<{ command: string; env: Record<string, string> }> = [];
    const sandbox: RepositoryCheckoutSandbox = {
      exec(command, options) {
        invocations.push({ command, env: options.env ?? {} });
        return Promise.resolve({
          exitCode: 0,
          stderr: "",
          stdout: command === REPOSITORY_HEADLINE_COMMAND ? "headline_replaced\n" : `${treeSha}\n`,
          success: true,
        });
      },
    };

    await expect(
      replaceRepositoryHeadline(
        sandbox,
        "src/domains/tacograph/pages/index.astro",
        "Cook smarter",
      ),
    ).resolves.toBe(treeSha);
    expect(invocations.map(({ command }) => command)).toEqual([
      REPOSITORY_HEADLINE_COMMAND,
      REPOSITORY_TREE_COMMAND,
    ]);
    expect(invocations[0]?.env).toMatchObject({
      LANDING_HEADLINE: "Cook smarter",
      REPOSITORY_PAGE_PATH: "src/domains/tacograph/pages/index.astro",
    });
    expect(invocations[0]?.env).not.toHaveProperty("REPOSITORY_CHECKOUT_TOKEN");
  });

  it("derives stable public revisions from immutable repository tree state", async () => {
    const first = await repositoryTreeRevision(BASE_SHA, "a".repeat(40));
    const repeated = await repositoryTreeRevision(BASE_SHA, "a".repeat(40));
    const changed = await repositoryTreeRevision(BASE_SHA, "b".repeat(40));

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(repeated).toBe(first);
    expect(changed).not.toBe(first);
  });

  it("rejects ambiguous edit diagnostics without exposing credential-like values", async () => {
    const sandbox: RepositoryCheckoutSandbox = {
      exec: () =>
        Promise.resolve({
          exitCode: 64,
          stderr: "token=should-not-escape\nExpected exactly one h1",
          stdout: "",
          success: false,
        }),
    };

    const failure = replaceRepositoryHeadline(
      sandbox,
      "src/domains/tacograph/pages/index.astro",
      "Cook smarter",
    );
    await expect(failure).rejects.toThrow("[REDACTED]");
    await expect(failure).rejects.not.toThrow("should-not-escape");
  });
});
