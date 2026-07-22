import type { ExecResult } from "@cloudflare/sandbox";

export const REPOSITORY_WORKSPACE_PATH = "/workspace/repository";
export const REPOSITORY_CHECKOUT_COMMAND =
  "/usr/local/bin/prepare-readonly-repository";

const COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/;
const RELEASE_REF_PATTERN = /^refs\/heads\/[A-Za-z0-9._/-]+$/;
const GITHUB_SSH_REMOTE_PATTERN = /^git@github\.com:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git)$/;

export interface RepositoryWorkspaceConfig {
  remoteUrl: string;
  checkoutUrl: string;
  releaseRef: string;
  baseSha: string;
}

export interface RepositoryWorkspaceEnvironment {
  REPOSITORY_REMOTE_URL: string;
  REPOSITORY_RELEASE_REF: string;
  REPOSITORY_BASE_SHA: string;
}

export interface RepositoryCheckoutSandbox {
  exec(command: string, options: {
    env: Record<string, string>;
    timeout: number;
  }): Promise<Pick<ExecResult, "success" | "exitCode" | "stdout">>;
}

export function repositoryWorkspaceConfig(
  env: RepositoryWorkspaceEnvironment,
): RepositoryWorkspaceConfig {
  const remoteUrl = env.REPOSITORY_REMOTE_URL.trim();
  const releaseRef = env.REPOSITORY_RELEASE_REF.trim();
  const baseSha = env.REPOSITORY_BASE_SHA.trim();
  const remoteMatch = GITHUB_SSH_REMOTE_PATTERN.exec(remoteUrl);

  if (remoteMatch === null || remoteMatch[1] === undefined) {
    throw new Error("REPOSITORY_REMOTE_URL must be a canonical GitHub SSH repository URL");
  }
  if (!RELEASE_REF_PATTERN.test(releaseRef) || releaseRef.includes("..")) {
    throw new Error("REPOSITORY_RELEASE_REF must be a canonical branch ref");
  }
  if (!COMMIT_SHA_PATTERN.test(baseSha)) {
    throw new Error("REPOSITORY_BASE_SHA must be a lowercase 40-character commit SHA");
  }

  return {
    remoteUrl,
    checkoutUrl: `https://github.com/${remoteMatch[1]}`,
    releaseRef,
    baseSha,
  };
}

export function assertRepositoryPagePath(pagePath: string): void {
  if (
    !pagePath.startsWith("src/domains/") ||
    pagePath.startsWith("/") ||
    pagePath.includes("..") ||
    !/^[A-Za-z0-9._/-]+$/.test(pagePath)
  ) {
    throw new Error("Repository page path must identify a source file under src/domains");
  }
}

export async function prepareRepositoryCheckout(
  sandbox: RepositoryCheckoutSandbox,
  config: RepositoryWorkspaceConfig,
  checkoutToken: string,
): Promise<void> {
  if (checkoutToken.trim().length === 0) {
    throw new Error("Repository checkout credential is unavailable");
  }

  let result: Pick<ExecResult, "success" | "exitCode" | "stdout">;
  try {
    result = await sandbox.exec(REPOSITORY_CHECKOUT_COMMAND, {
      env: {
        REPOSITORY_BASE_SHA: config.baseSha,
        REPOSITORY_CHECKOUT_TOKEN: checkoutToken,
        REPOSITORY_CHECKOUT_URL: config.checkoutUrl,
      },
      timeout: 120_000,
    });
  } catch {
    // Sandbox transport errors may contain serialized invocation details. Do
    // not let those details reach logs, durable state, or an MCP response.
    throw new Error("Repository checkout command failed");
  }

  if (!result.success) {
    throw new Error(
      `Repository checkout failed with exit code ${String(result.exitCode)}`,
    );
  }
  if (result.stdout.trim() !== config.baseSha) {
    throw new Error("Repository checkout did not verify the configured base SHA");
  }
}
