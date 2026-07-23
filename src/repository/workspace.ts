import type { ExecResult } from "@cloudflare/sandbox";
import type { LandingEditOperation } from "../domain/landing-edits";

export const REPOSITORY_WORKSPACE_PATH = "/workspace/repository";
export const REPOSITORY_CHECKOUT_COMMAND =
  "/usr/local/bin/prepare-readonly-repository";
export const REPOSITORY_INSTALL_COMMAND = "npm ci --no-audit --no-fund";
export const REPOSITORY_CHECK_COMMAND = "npm run check";
export const REPOSITORY_BUILD_COMMAND = "npm run build";
export const REPOSITORY_EDIT_COMMAND =
  "/usr/local/bin/apply-landing-edits";
export const REPOSITORY_TREE_COMMAND =
  "/usr/local/bin/snapshot-repository-tree";
export const REPOSITORY_RESTORE_COMMAND =
  "/usr/local/bin/restore-repository-tree";
export const REPOSITORY_PREVIEW_COMMAND =
  "./node_modules/.bin/astro preview --host 0.0.0.0 --port 4322";
export const REPOSITORY_PREVIEW_VERIFY_COMMAND =
  "/usr/local/bin/verify-repository-preview";

const MAX_DIAGNOSTIC_LENGTH = 4_096;
const VALIDATION_ENVIRONMENT = {
  CI: "true",
  NO_COLOR: "1",
  npm_config_update_notifier: "false",
} as const;

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

export interface RepositoryWorkspaceSandbox {
  exec(command: string, options: {
    cwd?: string;
    env?: Record<string, string>;
    timeout: number;
  }): Promise<Pick<ExecResult, "success" | "exitCode" | "stdout" | "stderr">>;
}

export type RepositoryCheckoutSandbox = RepositoryWorkspaceSandbox;

export type RepositoryValidationStep = "install" | "check" | "build";
export type RepositoryEditOperation = LandingEditOperation["operation"];

export interface RepositoryValidationResult {
  install: "passed";
  checks: readonly [typeof REPOSITORY_CHECK_COMMAND, typeof REPOSITORY_BUILD_COMMAND];
}

export class RepositoryValidationError extends Error {
  readonly step: RepositoryValidationStep;
  readonly exitCode: number | null;

  constructor(step: RepositoryValidationStep, exitCode: number | null, diagnostic: string) {
    const exitSummary = exitCode === null ? "command error" : `exit code ${String(exitCode)}`;
    const suffix = diagnostic.length === 0 ? "" : `: ${diagnostic}`;
    super(`Repository ${step} validation failed (${exitSummary})${suffix}`);
    this.name = "RepositoryValidationError";
    this.step = step;
    this.exitCode = exitCode;
  }
}

export class RepositoryEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepositoryEditError";
  }
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

  let result: Pick<ExecResult, "success" | "exitCode" | "stdout" | "stderr">;
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

export async function installAndValidateRepository(
  sandbox: RepositoryWorkspaceSandbox,
): Promise<RepositoryValidationResult> {
  await runRepositoryValidationStep(
    sandbox,
    "install",
    REPOSITORY_INSTALL_COMMAND,
    300_000,
  );
  await runRepositoryValidationStep(
    sandbox,
    "check",
    REPOSITORY_CHECK_COMMAND,
    300_000,
  );
  await runRepositoryValidationStep(
    sandbox,
    "build",
    REPOSITORY_BUILD_COMMAND,
    300_000,
  );

  return {
    install: "passed",
    checks: [REPOSITORY_CHECK_COMMAND, REPOSITORY_BUILD_COMMAND],
  };
}

export async function validateRepositoryChanges(
  sandbox: RepositoryWorkspaceSandbox,
): Promise<RepositoryValidationResult> {
  await runRepositoryValidationStep(
    sandbox,
    "check",
    REPOSITORY_CHECK_COMMAND,
    300_000,
  );
  await runRepositoryValidationStep(
    sandbox,
    "build",
    REPOSITORY_BUILD_COMMAND,
    300_000,
  );

  return {
    install: "passed",
    checks: [REPOSITORY_CHECK_COMMAND, REPOSITORY_BUILD_COMMAND],
  };
}

export async function applyRepositoryEdits(
  sandbox: RepositoryWorkspaceSandbox,
  pagePath: string,
  operations: readonly LandingEditOperation[],
): Promise<string> {
  assertRepositoryPagePath(pagePath);
  if (!pagePath.includes("/pages/") || !pagePath.endsWith(".astro")) {
    throw new RepositoryEditError("Landing edits require a resolved Astro page source");
  }
  if (operations.length === 0 || operations.length > 8) {
    throw new RepositoryEditError("A landing edit batch must contain 1 to 8 operations");
  }
  const serialized = JSON.stringify(operations);
  if (serialized.length > 20_000) {
    throw new RepositoryEditError("The landing edit batch is too large");
  }

  const edit = await runRepositoryEditCommand(sandbox, REPOSITORY_EDIT_COMMAND, {
    LANDING_EDIT_BATCH: serialized,
    REPOSITORY_PAGE_PATH: pagePath,
  });
  if (edit.stdout.trim() !== "landing_edits_applied") {
    throw new RepositoryEditError("The landing edit batch did not complete safely");
  }
  return snapshotRepositoryTree(sandbox, pagePath);
}

export async function snapshotRepositoryTree(
  sandbox: RepositoryWorkspaceSandbox,
  pagePath: string,
): Promise<string> {
  assertRepositoryPagePath(pagePath);
  const result = await runRepositoryEditCommand(sandbox, REPOSITORY_TREE_COMMAND, {
    REPOSITORY_PAGE_PATH: pagePath,
  });
  const treeSha = result.stdout.trim();
  if (!/^[a-f0-9]{40,64}$/.test(treeSha)) {
    throw new RepositoryEditError("The repository tree revision could not be verified");
  }
  return treeSha;
}

export async function restoreRepositoryTree(
  sandbox: RepositoryWorkspaceSandbox,
  pagePath: string,
  treeSha: string,
): Promise<void> {
  assertRepositoryPagePath(pagePath);
  if (!/^[a-f0-9]{40,64}$/.test(treeSha)) {
    throw new RepositoryEditError("The stored repository tree revision is invalid");
  }
  const result = await runRepositoryEditCommand(sandbox, REPOSITORY_RESTORE_COMMAND, {
    REPOSITORY_PAGE_PATH: pagePath,
    REPOSITORY_TREE_SHA: treeSha,
  });
  if (result.stdout.trim() !== treeSha) {
    throw new RepositoryEditError("The previous repository tree could not be restored");
  }
}

export async function repositoryTreeRevision(
  baseSha: string,
  treeSha: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`repository-tree-v1\0${baseSha}\0${treeSha}`),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function verifyRepositoryPreview(
  sandbox: RepositoryWorkspaceSandbox,
  operations: readonly LandingEditOperation[],
): Promise<void> {
  const serialized = JSON.stringify(operations);
  const result = await runRepositoryEditCommand(
    sandbox,
    REPOSITORY_PREVIEW_VERIFY_COMMAND,
    { LANDING_EDIT_BATCH: serialized },
  );
  if (result.stdout.trim() !== "preview_verified") {
    throw new RepositoryEditError("The rendered Astro route could not be verified");
  }
}

async function runRepositoryEditCommand(
  sandbox: RepositoryWorkspaceSandbox,
  command: string,
  env: Record<string, string>,
): Promise<Pick<ExecResult, "success" | "exitCode" | "stdout" | "stderr">> {
  let result: Pick<ExecResult, "success" | "exitCode" | "stdout" | "stderr">;
  try {
    result = await sandbox.exec(command, {
      cwd: REPOSITORY_WORKSPACE_PATH,
      env: { ...VALIDATION_ENVIRONMENT, ...env },
      timeout: 30_000,
    });
  } catch {
    throw new RepositoryEditError("The repository edit command could not be completed");
  }
  if (!result.success) {
    const diagnostic = boundedRedactedDiagnostic(result.stderr, result.stdout);
    throw new RepositoryEditError(
      diagnostic.length === 0
        ? `The repository edit was rejected (exit code ${String(result.exitCode)})`
        : diagnostic,
    );
  }
  return result;
}

async function runRepositoryValidationStep(
  sandbox: RepositoryWorkspaceSandbox,
  step: RepositoryValidationStep,
  command: string,
  timeout: number,
): Promise<void> {
  let result: Pick<ExecResult, "success" | "exitCode" | "stdout" | "stderr">;
  try {
    result = await sandbox.exec(command, {
      cwd: REPOSITORY_WORKSPACE_PATH,
      env: VALIDATION_ENVIRONMENT,
      timeout,
    });
  } catch {
    // Transport errors can serialize invocation or environment details. Keep
    // the public and durable failure message independent of the thrown value.
    throw new RepositoryValidationError(step, null, "Sandbox command failed");
  }

  if (!result.success) {
    throw new RepositoryValidationError(
      step,
      result.exitCode,
      boundedRedactedDiagnostic(result.stderr, result.stdout),
    );
  }
}

export function boundedRedactedDiagnostic(...outputs: string[]): string {
  const combined = outputs
    .filter((output) => output.trim().length > 0)
    .join("\n")
    .replace(/https?:\/\/[^\s/@:]+:[^\s/@]+@/gi, "https://[REDACTED]@")
    .replace(
      /\b[A-Za-z0-9_]*(?:token|secret|password|authorization)\s*[:=][^\r\n]*/gi,
      "[REDACTED]",
    )
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+\b/g, "[REDACTED]")
    .replace(
      /\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g,
      "[REDACTED]",
    )
    .trim();

  if (combined.length <= MAX_DIAGNOSTIC_LENGTH) {
    return combined;
  }
  return `${combined.slice(0, MAX_DIAGNOSTIC_LENGTH)}…[truncated]`;
}
