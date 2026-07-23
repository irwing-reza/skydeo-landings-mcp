import { DurableObject } from "cloudflare:workers";
import { getSandbox, type Process, type ProcessOptions } from "@cloudflare/sandbox";

import { summarizeLandingEdits, type LandingEditOperation } from "../domain/landing-edits";
import {
  assertDraftTransition,
  isDraftStatus,
  isRepositoryWorkspaceStatus,
  type DraftRecord,
  type DraftStatus,
} from "../domain/draft";
import {
  isRepositoryOperationStatus,
  isRepositoryOperationPhase,
  isRepositoryExecutionStep,
  repositoryExecutionPhase,
  repositoryProcessAction,
  type RepositoryExecutionStep,
  type RepositoryOperationPhase,
  type RepositoryOperationStatus,
} from "../domain/repository-execution";
import {
  isPreviewCleanupStatus,
  previewLifecycleState,
  previewTtlMilliseconds,
  runPreviewCleanup,
  shouldCleanupPreview,
  type PreviewLifecycleState,
} from "../domain/preview-lifecycle";
import { previewSandboxId } from "./preview-sandbox-id";
import { buildPreviewUrl } from "./preview-url";
import {
  assertRepositoryPagePath,
  boundedRedactedDiagnostic,
  REPOSITORY_BUILD_COMMAND,
  REPOSITORY_CHECKOUT_COMMAND,
  REPOSITORY_CHECK_COMMAND,
  REPOSITORY_EDIT_COMMAND,
  REPOSITORY_INSTALL_COMMAND,
  REPOSITORY_PREVIEW_COMMAND,
  REPOSITORY_PREVIEW_VERIFY_COMMAND,
  REPOSITORY_RESTORE_COMMAND,
  REPOSITORY_TREE_COMMAND,
  REPOSITORY_WORKSPACE_PATH,
  repositoryTreeRevision,
  repositoryWorkspaceConfig,
} from "../repository/workspace";

interface DraftRow extends Record<string, SqlStorageValue> {
  id: string;
  organization_id: string;
  created_by: string;
  hostname: string;
  status: string;
  base_revision: string;
  current_revision: string;
  approved_revision: string | null;
  preview_url: string | null;
  production_url: string | null;
  html: string;
  repository_remote_url: string | null;
  repository_release_ref: string | null;
  repository_base_sha: string | null;
  repository_page_path: string | null;
  repository_workspace_id: string | null;
  repository_workspace_status: string | null;
  repository_prepared_at: number | null;
  repository_tree_sha: string | null;
  repository_change_operation: string | null;
  repository_change_summary: string | null;
  repository_operation_status: string | null;
  repository_operation_phase: string | null;
  repository_execution_step: string | null;
  repository_process_id: string | null;
  repository_step_started_at: number | null;
  repository_step_deadline_at: number | null;
  repository_pending_tree_sha: string | null;
  repository_pending_failure: string | null;
  repository_operation_error: string | null;
  repository_operation_deadline_at: number | null;
  repository_operation_attempt: number;
  repository_idempotency_key: string | null;
  preview_expires_at: number | null;
  preview_revoked_at: number | null;
  preview_cleanup_status: string;
  preview_cleaned_at: number | null;
  created_at: number;
  updated_at: number;
}

export type CreateDraftInput = Pick<
  DraftRecord,
  "id" | "organizationId" | "createdBy" | "hostname" | "baseRevision" | "html"
> & { previewHostname: string };

export interface UpdateDraftInput {
  organizationId: string;
  expectedRevision: string;
  html: string;
  previewHostname: string;
}

export type CreateRepositoryDraftInput = Pick<
  DraftRecord,
  "id" | "organizationId" | "createdBy" | "hostname"
> & {
  edits: readonly LandingEditOperation[];
  idempotencyKey: string;
  pagePath: string;
  previewHostname: string;
};

export interface UpdateRepositoryDraftInput {
  expectedRevision: string;
  edits: readonly LandingEditOperation[];
  organizationId: string;
  previewHostname: string;
}

export interface PreviewAuthorization {
  allowed: boolean;
  state: PreviewLifecycleState;
}

const PREVIEW_PORT = 4321;
const PREVIEW_PROCESS_ID = "preview-server";
const REPOSITORY_PREVIEW_PROCESS_ID = "repository-preview-server";
const REPOSITORY_PREVIEW_PROXY_PROCESS_ID = "repository-preview-proxy";
const CLEANUP_RETRY_DELAY_MS = 5 * 60 * 1000;
const REPOSITORY_OPERATION_TIMEOUT_MS = 30 * 60 * 1000;
const REPOSITORY_POLL_INTERVAL_MS = 5_000;
const REPOSITORY_SHORT_STEP_TIMEOUT_MS = 30_000;
const REPOSITORY_CHECKOUT_TIMEOUT_MS = 120_000;
const REPOSITORY_VALIDATION_TIMEOUT_MS = 300_000;
const REPOSITORY_PREVIEW_READY_TIMEOUT_MS = 30_000;
const REPOSITORY_VALIDATION_ENVIRONMENT = {
  CI: "true",
  NO_COLOR: "1",
  npm_config_update_notifier: "false",
} as const;
const PREVIEW_SERVER_SOURCE = `
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const headers = {
  "content-security-policy": "default-src 'none'; img-src data: https:; style-src 'unsafe-inline'; font-src data: https:; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
  "content-type": "text/html; charset=utf-8",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

createServer(async (request, response) => {
  if (request.url === "/healthz") {
    response.writeHead(204).end();
    return;
  }

  const requestUrl = new URL(request.url ?? "/", "http://preview");
  const revision = requestUrl.searchParams.get("revision") ?? decodeURIComponent(requestUrl.pathname.slice(1));
  if (!/^[a-f0-9]{64}$/.test(revision)) {
    response.writeHead(404, headers).end("Preview revision not found");
    return;
  }

  try {
    const html = await readFile(\`/workspace/previews/\${revision}.html\`, "utf8");
    response.writeHead(200, headers).end(html);
  } catch {
    response.writeHead(404, headers).end("Preview revision not found");
  }
}).listen(4321, "0.0.0.0");
`;

export class DraftCoordinator extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    void ctx.blockConcurrencyWhile(() => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS draft (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL,
          created_by TEXT NOT NULL,
          hostname TEXT NOT NULL,
          status TEXT NOT NULL,
          base_revision TEXT NOT NULL,
          current_revision TEXT NOT NULL,
          approved_revision TEXT,
          preview_url TEXT,
          production_url TEXT,
          html TEXT NOT NULL DEFAULT '',
          repository_remote_url TEXT,
          repository_release_ref TEXT,
          repository_base_sha TEXT,
          repository_page_path TEXT,
          repository_workspace_id TEXT,
          repository_workspace_status TEXT,
          repository_prepared_at INTEGER,
          repository_tree_sha TEXT,
          repository_change_operation TEXT,
          repository_change_summary TEXT,
          repository_operation_status TEXT,
          repository_operation_phase TEXT,
          repository_execution_step TEXT,
          repository_process_id TEXT,
          repository_step_started_at INTEGER,
          repository_step_deadline_at INTEGER,
          repository_pending_tree_sha TEXT,
          repository_pending_failure TEXT,
          repository_operation_error TEXT,
          repository_operation_deadline_at INTEGER,
          repository_operation_attempt INTEGER NOT NULL DEFAULT 0,
          repository_idempotency_key TEXT,
          preview_expires_at INTEGER,
          preview_revoked_at INTEGER,
          preview_cleanup_status TEXT NOT NULL DEFAULT 'scheduled',
          preview_cleaned_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      const columns = this.ctx.storage.sql
        .exec<{ name: string }>("PRAGMA table_info(draft)")
        .toArray();
      this.ensureColumn(columns, "html", "TEXT NOT NULL DEFAULT ''");
      this.ensureColumn(columns, "repository_remote_url", "TEXT");
      this.ensureColumn(columns, "repository_release_ref", "TEXT");
      this.ensureColumn(columns, "repository_base_sha", "TEXT");
      this.ensureColumn(columns, "repository_page_path", "TEXT");
      this.ensureColumn(columns, "repository_workspace_id", "TEXT");
      this.ensureColumn(columns, "repository_workspace_status", "TEXT");
      this.ensureColumn(columns, "repository_prepared_at", "INTEGER");
      this.ensureColumn(columns, "repository_tree_sha", "TEXT");
      this.ensureColumn(columns, "repository_change_operation", "TEXT");
      this.ensureColumn(columns, "repository_change_summary", "TEXT");
      this.ensureColumn(columns, "repository_operation_status", "TEXT");
      this.ensureColumn(columns, "repository_operation_phase", "TEXT");
      this.ensureColumn(columns, "repository_execution_step", "TEXT");
      this.ensureColumn(columns, "repository_process_id", "TEXT");
      this.ensureColumn(columns, "repository_step_started_at", "INTEGER");
      this.ensureColumn(columns, "repository_step_deadline_at", "INTEGER");
      this.ensureColumn(columns, "repository_pending_tree_sha", "TEXT");
      this.ensureColumn(columns, "repository_pending_failure", "TEXT");
      this.ensureColumn(columns, "repository_operation_error", "TEXT");
      this.ensureColumn(columns, "repository_operation_deadline_at", "INTEGER");
      this.ensureColumn(
        columns,
        "repository_operation_attempt",
        "INTEGER NOT NULL DEFAULT 0",
      );
      this.ensureColumn(columns, "repository_idempotency_key", "TEXT");
      this.ensureColumn(columns, "preview_expires_at", "INTEGER");
      this.ensureColumn(columns, "preview_revoked_at", "INTEGER");
      this.ensureColumn(
        columns,
        "preview_cleanup_status",
        "TEXT NOT NULL DEFAULT 'scheduled'",
      );
      this.ensureColumn(columns, "preview_cleaned_at", "INTEGER");

      const ttl = previewTtlMilliseconds(this.env.PREVIEW_TTL_SECONDS);
      this.ctx.storage.sql.exec(
        `UPDATE draft
         SET preview_expires_at = updated_at + ?
         WHERE preview_expires_at IS NULL`,
        ttl,
      );
      return Promise.resolve();
    });
  }

  private ensureColumn(
    columns: Array<{ name: string }>,
    name: string,
    definition: string,
  ): void {
    if (!columns.some((column) => column.name === name)) {
      this.ctx.storage.sql.exec(`ALTER TABLE draft ADD COLUMN ${name} ${definition}`);
    }
  }

  async create(input: CreateDraftInput): Promise<DraftRecord> {
    if (this.readDraft() !== null) {
      throw new Error("Draft already exists");
    }

    const now = Date.now();
    const previewExpiresAt = now + previewTtlMilliseconds(this.env.PREVIEW_TTL_SECONDS);
    this.ctx.storage.sql.exec(
      `INSERT INTO draft (
        id, organization_id, created_by, hostname, status, base_revision,
        current_revision, approved_revision, preview_url, production_url, html,
        preview_expires_at, preview_revoked_at, preview_cleanup_status,
        preview_cleaned_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'draft', ?, ?, NULL, NULL, NULL, '', ?, NULL,
        'scheduled', NULL, ?, ?)`,
      input.id,
      input.organizationId,
      input.createdBy,
      input.hostname,
      input.baseRevision,
      input.baseRevision,
      previewExpiresAt,
      now,
      now,
    );
    this.logEvent("draft_created", { actorId: input.createdBy });

    return this.renderPreview(input.organizationId, input.html, input.previewHostname);
  }

  async get(organizationId: string): Promise<DraftRecord> {
    const draft = this.requireOrganization(organizationId);
    await this.ensureNextAlarm(draft);
    return draft;
  }

  async createRepositoryDraft(
    input: CreateRepositoryDraftInput,
  ): Promise<DraftRecord> {
    const existing = this.readDraft();
    if (existing !== null) {
      if (
        existing.organizationId === input.organizationId &&
        existing.createdBy === input.createdBy &&
        existing.repositoryIdempotencyKey === input.idempotencyKey &&
        existing.hostname === input.hostname &&
        existing.repositoryPagePath === input.pagePath &&
        existing.repositoryChangeOperation === JSON.stringify(input.edits)
      ) {
        await this.ensureNextAlarm(existing);
        return existing;
      }
      throw new Error("The idempotency key is already bound to a different request");
    }

    const config = repositoryWorkspaceConfig(this.env);
    assertRepositoryPagePath(input.pagePath);
    const workspaceId = previewSandboxId(input.organizationId, input.id);
    const now = Date.now();
    const previewExpiresAt = now + previewTtlMilliseconds(this.env.PREVIEW_TTL_SECONDS);
    this.ctx.storage.sql.exec(
      `INSERT INTO draft (
        id, organization_id, created_by, hostname, status, base_revision,
        current_revision, approved_revision, preview_url, production_url, html,
        repository_remote_url, repository_release_ref, repository_base_sha,
        repository_page_path, repository_workspace_id, repository_workspace_status,
        repository_prepared_at, repository_tree_sha, repository_change_operation,
        repository_change_summary, repository_operation_status,
        repository_operation_phase, repository_operation_error,
        repository_operation_deadline_at,
        repository_operation_attempt, repository_idempotency_key,
        preview_expires_at, preview_revoked_at,
        preview_cleanup_status, preview_cleaned_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'draft', ?, ?, NULL, NULL, NULL, '', ?, ?, ?, ?, ?,
        'preparing', NULL, NULL, ?, ?, 'queued', NULL, NULL, ?, 0, ?, ?, NULL,
        'scheduled', NULL, ?, ?)`,
      input.id,
      input.organizationId,
      input.createdBy,
      input.hostname,
      config.baseSha,
      config.baseSha,
      config.remoteUrl,
      config.releaseRef,
      config.baseSha,
      input.pagePath,
      workspaceId,
      JSON.stringify(input.edits),
      "Repository workspace preparation is queued.",
      now + REPOSITORY_OPERATION_TIMEOUT_MS,
      input.idempotencyKey,
      previewExpiresAt,
      now,
      now,
    );
    this.logEvent("repository_operation_queued", { workspaceId });
    await this.ctx.storage.setAlarm(now);
    return this.requireDraft();
  }

  async updateRepositoryDraft(
    input: UpdateRepositoryDraftInput,
  ): Promise<DraftRecord> {
    const draft = this.requireOrganization(input.organizationId);
    if (draft.currentRevision !== input.expectedRevision) {
      throw new Error(
        `Draft revision conflict: expected ${input.expectedRevision}, current ${draft.currentRevision}`,
      );
    }
    if (
      draft.repositoryWorkspaceStatus !== "ready" ||
      draft.repositoryWorkspaceId === null ||
      draft.repositoryPagePath === null ||
      draft.repositoryBaseSha === null ||
      draft.repositoryTreeSha === null
    ) {
      throw new Error("This draft does not have a reusable repository workspace");
    }
    if (
      draft.repositoryOperationStatus === "queued" ||
      draft.repositoryOperationStatus === "running"
    ) {
      throw new Error("A repository operation is already in progress for this draft");
    }
    if (previewLifecycleState(draft) !== "active") {
      throw new Error("The repository workspace is expired or revoked; start a new update");
    }

    const config = repositoryWorkspaceConfig(this.env);
    if (
      config.remoteUrl !== draft.repositoryRemoteUrl ||
      config.baseSha !== draft.repositoryBaseSha ||
      config.releaseRef !== draft.repositoryReleaseRef
    ) {
      throw new Error("The configured repository boundary no longer matches this draft");
    }
    this.transition("building");
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `UPDATE draft
       SET repository_change_operation = ?, repository_change_summary = ?,
           repository_operation_status = 'queued', repository_operation_error = NULL,
           repository_operation_phase = NULL,
           repository_execution_step = NULL, repository_process_id = NULL,
           repository_step_started_at = NULL, repository_step_deadline_at = NULL,
           repository_pending_tree_sha = NULL, repository_pending_failure = NULL,
           repository_operation_deadline_at = ?,
           updated_at = ?
       WHERE id = ?`,
      JSON.stringify(input.edits),
      "Repository edit and validation are queued.",
      now + REPOSITORY_OPERATION_TIMEOUT_MS,
      now,
      draft.id,
    );
    this.logEvent("repository_operation_queued", {
      revision: input.expectedRevision,
    });
    await this.ctx.storage.setAlarm(now);
    return this.requireDraft();
  }

  async update(input: UpdateDraftInput): Promise<DraftRecord> {
    const draft = this.requireOrganization(input.organizationId);
    if (draft.currentRevision !== input.expectedRevision) {
      throw new Error(
        `Draft revision conflict: expected ${input.expectedRevision}, current ${draft.currentRevision}`,
      );
    }
    this.logEvent("draft_updated", { revision: input.expectedRevision });
    return this.renderPreview(input.organizationId, input.html, input.previewHostname);
  }

  async authorizePreview(
    organizationId: string,
    revision: string | null,
  ): Promise<PreviewAuthorization> {
    await this.ensureCleanupAlarm(this.requireOrganization(organizationId));
    const draft = this.requireOrganization(organizationId);
    const state = previewLifecycleState(draft);
    if (
      state === "active" &&
      (revision === null || revision === draft.currentRevision)
    ) {
      this.logEvent("preview_opened", { revision: revision ?? draft.currentRevision });
      return { allowed: true, state };
    }

    this.logEvent("preview_access_denied", {
      revision: revision ?? draft.currentRevision,
      state: revision !== null && revision !== draft.currentRevision ? "revision_mismatch" : state,
    });
    return { allowed: false, state };
  }

  async revokePreview(organizationId: string, actorId: string): Promise<DraftRecord> {
    const draft = this.requireOrganization(organizationId);
    if (draft.previewRevokedAt === null && draft.previewCleanedAt === null) {
      const now = Date.now();
      this.ctx.storage.sql.exec(
        `UPDATE draft
         SET preview_revoked_at = ?, preview_cleanup_status = 'scheduled',
             repository_operation_status = CASE
               WHEN repository_operation_status IN ('queued', 'running') THEN 'cancelled'
               ELSE repository_operation_status
             END,
             repository_operation_error = CASE
               WHEN repository_operation_status IN ('queued', 'running')
                 THEN 'Repository operation cancelled by preview revocation.'
               ELSE repository_operation_error
             END,
             updated_at = ?
         WHERE id = ?`,
        now,
        now,
        draft.id,
      );
      this.logEvent("preview_revoked", { actorId, revision: draft.currentRevision });
    }

    const revoked = this.requireDraft();
    await this.ensureNextAlarm(revoked);
    return revoked;
  }

  async cleanupPreview(organizationId: string): Promise<DraftRecord> {
    const draft = this.requireOrganization(organizationId);
    if (!shouldCleanupPreview(draft)) {
      await this.ensureCleanupAlarm(draft);
      return draft;
    }
    if (draft.previewCleanupStatus === "complete") {
      return draft;
    }

    this.ctx.storage.sql.exec(
      "UPDATE draft SET preview_cleanup_status = 'in_progress', updated_at = ? WHERE id = ?",
      Date.now(),
      draft.id,
    );

    try {
      const sandbox = getSandbox(
        this.env.Sandbox,
        previewSandboxId(draft.organizationId, draft.id),
        { normalizeId: true },
      );
      const result = await runPreviewCleanup(draft, () => sandbox.destroy());
      const cleanedAt = result.cleanedAt;
      if (!result.attempted || cleanedAt === null) {
        return this.requireDraft();
      }
      this.ctx.storage.sql.exec(
        `UPDATE draft
         SET preview_cleanup_status = 'complete', preview_cleaned_at = ?,
             preview_url = NULL, updated_at = ?
         WHERE id = ?`,
        cleanedAt,
        cleanedAt,
        draft.id,
      );
      await this.ctx.storage.deleteAlarm();
      this.logEvent("preview_cleaned_up", { revision: draft.currentRevision });
    } catch (error: unknown) {
      const retryAt = Date.now() + CLEANUP_RETRY_DELAY_MS;
      this.ctx.storage.sql.exec(
        "UPDATE draft SET preview_cleanup_status = 'failed', updated_at = ? WHERE id = ?",
        Date.now(),
        draft.id,
      );
      await this.ctx.storage.setAlarm(retryAt);
      this.logEvent("preview_cleanup_failed", {
        error: error instanceof Error ? error.message : "Unknown cleanup failure",
        revision: draft.currentRevision,
      });
    }

    return this.requireDraft();
  }

  override async alarm(): Promise<void> {
    const draft = this.readDraft();
    if (draft === null) {
      return;
    }
    const lifecycle = previewLifecycleState(draft);
    if (lifecycle === "expired") {
      this.logEvent("preview_expired", { revision: draft.currentRevision });
    }
    if (lifecycle !== "active") {
      this.cancelRepositoryOperationForLifecycle(draft, lifecycle);
      await this.cleanupPreview(draft.organizationId);
      return;
    }
    if (
      draft.repositoryOperationStatus === "queued" ||
      draft.repositoryOperationStatus === "running"
    ) {
      await this.runRepositoryOperation(draft);
    }
    await this.ensureNextAlarm(this.requireDraft());
  }

  private async runRepositoryOperation(started: DraftRecord): Promise<void> {
    let operations: readonly LandingEditOperation[];
    try {
      operations = parseStoredLandingEdits(started.repositoryChangeOperation);
    } catch {
      await this.failRepositoryOperation(
        started,
        "Stored repository operation is invalid; the workspace was retired.",
      );
      return;
    }
    if (
      started.repositoryWorkspaceId === null ||
      started.repositoryPagePath === null ||
      started.repositoryBaseSha === null
    ) {
      await this.failRepositoryOperation(started, "Repository operation state is incomplete.");
      return;
    }
    if (
      started.repositoryOperationDeadlineAt === null ||
      Date.now() >= started.repositoryOperationDeadlineAt
    ) {
      await this.stopActiveRepositoryProcess(started);
      await this.handleRepositoryStepFailure(
        started,
        "Repository operation timed out before completion.",
      );
      return;
    }

    if (started.repositoryOperationStatus === "queued") {
      const step: RepositoryExecutionStep =
        started.repositoryTreeSha === null ? "checkout" : "restore";
      const now = Date.now();
      this.ctx.storage.sql.exec(
        `UPDATE draft
         SET repository_operation_status = 'running',
             repository_operation_attempt = repository_operation_attempt + 1,
             repository_operation_phase = ?, repository_execution_step = ?,
             repository_process_id = NULL, repository_step_started_at = NULL,
             repository_step_deadline_at = NULL, repository_pending_tree_sha = NULL,
             repository_pending_failure = NULL, repository_operation_error = NULL,
             updated_at = ?
         WHERE id = ?`,
        repositoryExecutionPhase(step),
        step,
        now,
        started.id,
      );
      this.logEvent("repository_operation_started", {
        attempt: started.repositoryOperationAttempt + 1,
        step,
      });
      return;
    }

    if (started.repositoryExecutionStep === null) {
      await this.failRepositoryOperation(
        started,
        "Repository execution state predates durable step tracking; the workspace was retired safely.",
      );
      return;
    }

    if (
      started.repositoryExecutionStep === "preview_astro_ready" ||
      started.repositoryExecutionStep === "preview_proxy_ready"
    ) {
      await this.pollRepositoryPreviewReadiness(started);
      return;
    }
    if (started.repositoryExecutionStep === "preview_expose") {
      await this.completeRepositoryPreview(started, operations);
      return;
    }
    await this.advanceRepositoryProcessStep(started, operations);
  }

  private async advanceRepositoryProcessStep(
    draft: DraftRecord,
    operations: readonly LandingEditOperation[],
  ): Promise<void> {
    const step = draft.repositoryExecutionStep;
    if (step === null) return;
    const workspaceId = draft.repositoryWorkspaceId;
    const operationDeadline = draft.repositoryOperationDeadlineAt;
    if (workspaceId === null || operationDeadline === null) {
      await this.failRepositoryOperation(draft, "Repository operation state is incomplete.");
      return;
    }
    let specification: RepositoryProcessSpecification;
    try {
      specification = this.repositoryProcessSpecification(draft, step, operations);
    } catch {
      await this.handleRepositoryStepFailure(
        draft,
        "Repository command configuration is unavailable.",
      );
      return;
    }
    const sandbox = getSandbox(this.env.Sandbox, workspaceId, {
      labels: { draftId: draft.id, organizationId: draft.organizationId },
      normalizeId: true,
    });
    const now = Date.now();
    let processId = draft.repositoryProcessId;
    let stepDeadline = draft.repositoryStepDeadlineAt;

    if (processId === null) {
      processId = this.repositoryProcessId(draft, step);
      stepDeadline = Math.min(
        operationDeadline,
        now + specification.timeout,
      );
      this.ctx.storage.sql.exec(
        `UPDATE draft
         SET repository_process_id = ?, repository_step_started_at = ?,
             repository_step_deadline_at = ?, updated_at = ?
         WHERE id = ?`,
        processId,
        now,
        stepDeadline,
        now,
        draft.id,
      );
      this.logEvent("repository_step_dispatching", { processId, step });
    }

    let process: Process | null;
    try {
      process = await sandbox.getProcess(processId);
    } catch {
      this.logEvent("repository_step_poll_retry", { processId, step });
      return;
    }
    const action = repositoryProcessAction(
      processId,
      process?.status ?? null,
      now,
      stepDeadline,
    );
    if (action === "timeout") {
      if (process !== null && ["starting", "running"].includes(process.status)) {
        try {
          await process.kill();
        } catch {
          this.logEvent("repository_step_kill_failed", { processId, step });
        }
      }
      await this.handleRepositoryStepFailure(
        this.requireDraft(),
        this.repositoryStepTimeoutMessage(step, specification.timeout),
      );
      return;
    }
    if (action === "dispatch") {
      try {
        await sandbox.startProcess(specification.command, {
          ...specification.options,
          autoCleanup: false,
          processId,
          timeout: specification.timeout,
        });
        this.logEvent("repository_step_dispatched", { processId, step });
      } catch {
        // The dispatch response may be lost after the Container accepted the
        // deterministic process ID. A later alarm always checks that ID first.
        this.logEvent("repository_step_dispatch_retry", { processId, step });
      }
      return;
    }
    if (action === "poll") {
      if (
        (step === "preview_start" || step === "preview_proxy") &&
        process?.status === "running"
      ) {
        await this.completeRepositoryProcessStep(draft, step, "", operations);
      }
      return;
    }

    if (process === null) {
      await this.handleRepositoryStepFailure(
        this.requireDraft(),
        `Repository ${this.repositoryStepLabel(step)} process state was lost.`,
      );
      return;
    }
    let logs: { stdout: string; stderr: string };
    try {
      logs = await process.getLogs();
    } catch {
      await this.handleRepositoryStepFailure(
        this.requireDraft(),
        `Repository ${this.repositoryStepLabel(step)} logs could not be retrieved safely.`,
      );
      return;
    }
    if (process.status !== "completed" || process.exitCode !== 0) {
      const diagnostic = boundedRedactedDiagnostic(logs.stderr, logs.stdout);
      const suffix = diagnostic.length === 0 ? "" : `: ${diagnostic}`;
      await this.handleRepositoryStepFailure(
        this.requireDraft(),
        `Repository ${this.repositoryStepLabel(step)} failed (exit code ${String(process.exitCode ?? "unknown")})${suffix}`,
      );
      return;
    }
    await this.completeRepositoryProcessStep(draft, step, logs.stdout, operations);
  }

  private async completeRepositoryProcessStep(
    draft: DraftRecord,
    step: RepositoryExecutionStep,
    stdout: string,
    operations: readonly LandingEditOperation[],
  ): Promise<void> {
    if (step === "checkout" && stdout.trim() !== draft.repositoryBaseSha) {
      await this.handleRepositoryStepFailure(
        this.requireDraft(),
        "Repository checkout did not verify the configured base SHA.",
      );
      return;
    }
    if (step === "edit" && stdout.trim() !== "landing_edits_applied") {
      await this.handleRepositoryStepFailure(
        this.requireDraft(),
        "The landing edit batch did not complete safely.",
      );
      return;
    }
    if (step === "snapshot") {
      const treeSha = stdout.trim();
      if (!/^[a-f0-9]{40,64}$/.test(treeSha)) {
        await this.handleRepositoryStepFailure(
          this.requireDraft(),
          "The repository tree revision could not be verified.",
        );
        return;
      }
      this.ctx.storage.sql.exec(
        "UPDATE draft SET repository_pending_tree_sha = ? WHERE id = ?",
        treeSha,
        draft.id,
      );
    }
    if (
      (step === "restore" || step === "failure_restore") &&
      stdout.trim() !== draft.repositoryTreeSha
    ) {
      await this.failRepositoryOperation(
        this.requireDraft(),
        "The previous repository tree could not be restored safely; the workspace was retired.",
      );
      return;
    }
    if (step === "preview_verify" && stdout.trim() !== "preview_verified") {
      await this.handleRepositoryStepFailure(
        this.requireDraft(),
        "The rendered Astro route could not be verified.",
      );
      return;
    }
    if (step === "failure_restore") {
      this.completeRepositoryValidationFailure(this.requireDraft());
      return;
    }

    const next = nextRepositoryExecutionStep(step);
    if (next === null) {
      await this.failRepositoryOperation(
        this.requireDraft(),
        "Repository execution reached an invalid terminal step.",
      );
      return;
    }
    if (step === "base_build") {
      const preparedAt = Date.now();
      this.ctx.storage.sql.exec(
        `UPDATE draft
         SET repository_workspace_status = 'ready', repository_prepared_at = ?,
             status = 'building', repository_change_summary = ?, updated_at = ?
         WHERE id = ?`,
        preparedAt,
        "Repository workspace is ready; the bounded edit is being validated.",
        preparedAt,
        draft.id,
      );
      this.logEvent("repository_workspace_ready", {
        revision: draft.repositoryBaseSha,
        workspaceId: draft.repositoryWorkspaceId,
      });
    }
    this.setRepositoryExecutionStep(next);
    this.logEvent("repository_step_completed", { step });
    void operations;
  }

  private repositoryProcessSpecification(
    draft: DraftRecord,
    step: RepositoryExecutionStep,
    operations: readonly LandingEditOperation[],
  ): RepositoryProcessSpecification {
    const pagePath = draft.repositoryPagePath;
    if (pagePath === null) {
      throw new Error("Repository page path is unavailable.");
    }
    const editEnvironment = {
      ...REPOSITORY_VALIDATION_ENVIRONMENT,
      LANDING_EDIT_BATCH: JSON.stringify(operations),
      REPOSITORY_PAGE_PATH: pagePath,
    };
    switch (step) {
      case "checkout": {
        const config = repositoryWorkspaceConfig(this.env);
        if (this.env.REPOSITORY_CHECKOUT_TOKEN.trim().length === 0) {
          throw new Error("Repository checkout credential is unavailable.");
        }
        return {
          command: REPOSITORY_CHECKOUT_COMMAND,
          options: {
            env: {
              REPOSITORY_BASE_SHA: config.baseSha,
              REPOSITORY_CHECKOUT_TOKEN: this.env.REPOSITORY_CHECKOUT_TOKEN,
              REPOSITORY_CHECKOUT_URL: config.checkoutUrl,
            },
          },
          timeout: REPOSITORY_CHECKOUT_TIMEOUT_MS,
        };
      }
      case "install":
        return validationProcessSpecification(REPOSITORY_INSTALL_COMMAND);
      case "base_check":
      case "check":
        return validationProcessSpecification(REPOSITORY_CHECK_COMMAND);
      case "base_build":
      case "build":
        return validationProcessSpecification(REPOSITORY_BUILD_COMMAND);
      case "restore":
      case "failure_restore": {
        const treeSha = draft.repositoryTreeSha;
        if (treeSha === null) {
          throw new Error("Repository tree revision is unavailable.");
        }
        return {
          command: REPOSITORY_RESTORE_COMMAND,
          options: {
            cwd: REPOSITORY_WORKSPACE_PATH,
            env: {
              ...REPOSITORY_VALIDATION_ENVIRONMENT,
              REPOSITORY_PAGE_PATH: pagePath,
              REPOSITORY_TREE_SHA: treeSha,
            },
          },
          timeout: REPOSITORY_SHORT_STEP_TIMEOUT_MS,
        };
      }
      case "edit":
        return {
          command: REPOSITORY_EDIT_COMMAND,
          options: { cwd: REPOSITORY_WORKSPACE_PATH, env: editEnvironment },
          timeout: REPOSITORY_SHORT_STEP_TIMEOUT_MS,
        };
      case "snapshot":
        return {
          command: REPOSITORY_TREE_COMMAND,
          options: {
            cwd: REPOSITORY_WORKSPACE_PATH,
            env: {
              ...REPOSITORY_VALIDATION_ENVIRONMENT,
              REPOSITORY_PAGE_PATH: pagePath,
            },
          },
          timeout: REPOSITORY_SHORT_STEP_TIMEOUT_MS,
        };
      case "preview_start":
        return {
          command: REPOSITORY_PREVIEW_COMMAND,
          options: {
            autoCleanup: false,
            cwd: REPOSITORY_WORKSPACE_PATH,
            env: { CI: "true", NO_COLOR: "1" },
          },
          timeout: REPOSITORY_OPERATION_TIMEOUT_MS,
        };
      case "preview_proxy":
        return {
          command: "/usr/local/bin/repository-preview-proxy",
          options: {
            autoCleanup: false,
            env: { REPOSITORY_PREVIEW_HOSTNAME: draft.hostname },
          },
          timeout: REPOSITORY_OPERATION_TIMEOUT_MS,
        };
      case "preview_verify":
        return {
          command: REPOSITORY_PREVIEW_VERIFY_COMMAND,
          options: { cwd: REPOSITORY_WORKSPACE_PATH, env: editEnvironment },
          timeout: REPOSITORY_SHORT_STEP_TIMEOUT_MS,
        };
      case "preview_astro_ready":
      case "preview_proxy_ready":
      case "preview_expose":
        throw new Error(`Repository step ${step} does not dispatch a command.`);
    }
  }

  private async pollRepositoryPreviewReadiness(draft: DraftRecord): Promise<void> {
    const step = draft.repositoryExecutionStep;
    const operationDeadline = draft.repositoryOperationDeadlineAt;
    const workspaceId = draft.repositoryWorkspaceId;
    if (
      (step !== "preview_astro_ready" && step !== "preview_proxy_ready") ||
      operationDeadline === null ||
      workspaceId === null
    ) {
      await this.failRepositoryOperation(draft, "Repository preview state is incomplete.");
      return;
    }
    const processId = step === "preview_astro_ready"
      ? REPOSITORY_PREVIEW_PROCESS_ID
      : REPOSITORY_PREVIEW_PROXY_PROCESS_ID;
    const now = Date.now();
    let deadline = draft.repositoryStepDeadlineAt;
    if (deadline === null) {
      deadline = Math.min(
        operationDeadline,
        now + REPOSITORY_PREVIEW_READY_TIMEOUT_MS,
      );
      this.ctx.storage.sql.exec(
        `UPDATE draft
         SET repository_step_started_at = ?, repository_step_deadline_at = ?, updated_at = ?
         WHERE id = ?`,
        now,
        deadline,
        now,
        draft.id,
      );
    }
    const sandbox = getSandbox(this.env.Sandbox, workspaceId, {
      normalizeId: true,
    });
    try {
      const process = await sandbox.getProcess(processId);
      if (process === null || !["starting", "running"].includes(process.status)) {
        throw new Error("preview process unavailable");
      }
      if (step === "preview_astro_ready") {
        await process.waitForPort(4322, { mode: "tcp", timeout: 1_000 });
      } else {
        await process.waitForPort(PREVIEW_PORT, {
          path: "/__mcp_healthz",
          status: 204,
          timeout: 1_000,
        });
      }
    } catch {
      if (Date.now() < deadline) return;
      await this.handleRepositoryStepFailure(
        this.requireDraft(),
        "Repository preview did not become ready within its bounded startup window.",
      );
      return;
    }
    this.setRepositoryExecutionStep(
      step === "preview_astro_ready" ? "preview_proxy" : "preview_verify",
    );
    this.logEvent("repository_step_completed", { step });
  }

  private async completeRepositoryPreview(
    draft: DraftRecord,
    operations: readonly LandingEditOperation[],
  ): Promise<void> {
    if (draft.repositoryPendingTreeSha === null) {
      await this.handleRepositoryStepFailure(
        draft,
        "The validated repository tree revision is unavailable.",
      );
      return;
    }
    const baseSha = draft.repositoryBaseSha;
    const workspaceId = draft.repositoryWorkspaceId;
    if (baseSha === null || workspaceId === null) {
      await this.failRepositoryOperation(draft, "Repository preview state is incomplete.");
      return;
    }
    try {
      const revision = await repositoryTreeRevision(
        baseSha,
        draft.repositoryPendingTreeSha,
      );
      const sandbox = getSandbox(this.env.Sandbox, workspaceId, {
        labels: { draftId: draft.id, organizationId: draft.organizationId },
        normalizeId: true,
      });
      const exposed = await sandbox.exposePort(PREVIEW_PORT, {
        hostname: this.env.PREVIEW_HOSTNAME,
        name: "landing-preview",
      });
      const previewUrl = buildPreviewUrl(
        exposed.url,
        revision,
        this.env.PREVIEW_HOSTNAME,
      );
      const now = Date.now();
      const previewExpiresAt = now + previewTtlMilliseconds(this.env.PREVIEW_TTL_SECONDS);
      const changeSummary = summarizeLandingEdits(draft.hostname, operations);
      this.ctx.storage.sql.exec(
        `UPDATE draft
         SET status = 'preview_ready', current_revision = ?, preview_url = ?,
             repository_tree_sha = repository_pending_tree_sha,
             repository_change_summary = ?, repository_operation_status = 'succeeded',
             repository_operation_error = NULL, repository_operation_deadline_at = NULL,
             repository_process_id = NULL, repository_step_started_at = NULL,
             repository_step_deadline_at = NULL, repository_pending_tree_sha = NULL,
             repository_pending_failure = NULL, preview_expires_at = ?,
             preview_revoked_at = NULL, preview_cleanup_status = 'scheduled',
             preview_cleaned_at = NULL, updated_at = ?
         WHERE id = ?`,
        revision,
        previewUrl,
        changeSummary,
        previewExpiresAt,
        now,
        draft.id,
      );
      this.logEvent("repository_preview_ready", {
        revision,
        treeSha: draft.repositoryPendingTreeSha,
      });
      this.logEvent("repository_operation_succeeded", { revision });
    } catch {
      await this.handleRepositoryStepFailure(
        this.requireDraft(),
        "Repository preview exposure failed.",
      );
    }
  }

  private async handleRepositoryStepFailure(
    draft: DraftRecord,
    message: string,
  ): Promise<void> {
    const safeMessage = boundedRedactedDiagnostic(message);
    if (
      draft.repositoryTreeSha !== null &&
      draft.repositoryExecutionStep !== "failure_restore"
    ) {
      this.ctx.storage.sql.exec(
        `UPDATE draft
         SET repository_pending_failure = ?, repository_execution_step = 'failure_restore',
             repository_operation_phase = 'checkout', repository_process_id = NULL,
             repository_step_started_at = NULL, repository_step_deadline_at = NULL,
             updated_at = ?
         WHERE id = ?`,
        safeMessage,
        Date.now(),
        draft.id,
      );
      this.logEvent("repository_failure_restore_queued", { error: safeMessage });
      return;
    }
    await this.failRepositoryOperation(draft, safeMessage);
  }

  private completeRepositoryValidationFailure(draft: DraftRecord): void {
    const message = draft.repositoryPendingFailure ?? "Repository validation failed.";
    const failedAt = Date.now();
    this.ctx.storage.sql.exec(
      `UPDATE draft
       SET status = 'preview_ready', repository_operation_status = 'validation_failed',
           repository_operation_error = ?, repository_operation_deadline_at = NULL,
           repository_change_summary = ?, repository_process_id = NULL,
           repository_step_started_at = NULL, repository_step_deadline_at = NULL,
           repository_pending_tree_sha = NULL, repository_pending_failure = NULL,
           updated_at = ?
       WHERE id = ?`,
      message,
      "The requested edit was not saved; the previous revision remains active.",
      failedAt,
      draft.id,
    );
    this.logEvent("repository_operation_validation_failed", { error: message });
  }

  private async stopActiveRepositoryProcess(draft: DraftRecord): Promise<void> {
    if (draft.repositoryWorkspaceId === null || draft.repositoryProcessId === null) return;
    try {
      const sandbox = getSandbox(this.env.Sandbox, draft.repositoryWorkspaceId, {
        normalizeId: true,
      });
      const process = await sandbox.getProcess(draft.repositoryProcessId);
      if (process !== null && ["starting", "running"].includes(process.status)) {
        await process.kill();
      }
    } catch {
      this.logEvent("repository_step_kill_failed", {
        processId: draft.repositoryProcessId,
        step: draft.repositoryExecutionStep,
      });
    }
  }

  private repositoryProcessId(
    draft: DraftRecord,
    step: RepositoryExecutionStep,
  ): string {
    if (step === "preview_start") return REPOSITORY_PREVIEW_PROCESS_ID;
    if (step === "preview_proxy") return REPOSITORY_PREVIEW_PROXY_PROCESS_ID;
    return `repository-${String(draft.repositoryOperationAttempt)}-${step}`;
  }

  private repositoryStepLabel(step: RepositoryExecutionStep): string {
    if (step === "base_check" || step === "check") return "check validation";
    if (step === "base_build" || step === "build") return "build validation";
    return step.replaceAll("_", " ");
  }

  private repositoryStepTimeoutMessage(
    step: RepositoryExecutionStep,
    timeout: number,
  ): string {
    return `Repository ${this.repositoryStepLabel(step)} timed out after ${String(timeout)}ms.`;
  }

  private cancelRepositoryOperationForLifecycle(
    draft: DraftRecord,
    lifecycle: PreviewLifecycleState,
  ): void {
    if (
      draft.repositoryOperationStatus !== "queued" &&
      draft.repositoryOperationStatus !== "running"
    ) {
      return;
    }
    this.ctx.storage.sql.exec(
      `UPDATE draft
       SET repository_operation_status = 'cancelled', repository_operation_error = ?,
           repository_operation_deadline_at = NULL, repository_process_id = NULL,
           repository_step_started_at = NULL, repository_step_deadline_at = NULL,
           updated_at = ?
       WHERE id = ?`,
      `Repository operation cancelled because the draft is ${lifecycle}.`,
      Date.now(),
      draft.id,
    );
    this.logEvent("repository_operation_cancelled", { lifecycle });
  }

  private async failRepositoryOperation(
    draft: DraftRecord,
    message: string,
  ): Promise<void> {
    const cleanupComplete = await this.destroyRepositoryWorkspace(draft);
    const failedAt = Date.now();
    this.ctx.storage.sql.exec(
      `UPDATE draft
       SET status = 'failed', repository_workspace_status = 'failed',
           repository_operation_status = 'failed', repository_operation_error = ?,
           repository_operation_deadline_at = NULL, repository_change_summary = ?,
           repository_process_id = NULL, repository_step_started_at = NULL,
           repository_step_deadline_at = NULL, repository_pending_tree_sha = NULL,
           repository_pending_failure = NULL,
           preview_expires_at = ?, preview_cleanup_status = ?,
           preview_cleaned_at = ?, preview_url = NULL, updated_at = ?
       WHERE id = ?`,
      message,
      "No repository revision was saved and the disposable workspace was retired.",
      failedAt,
      cleanupComplete ? "complete" : "failed",
      cleanupComplete ? failedAt : null,
      failedAt,
      draft.id,
    );
    this.logEvent("repository_operation_failed", {
      cleanupComplete: cleanupComplete ? 1 : 0,
      error: message,
    });
    this.logEvent("repository_workspace_failed", {
      cleanupComplete: cleanupComplete ? 1 : 0,
      workspaceId: draft.repositoryWorkspaceId,
    });
  }

  private async destroyRepositoryWorkspace(draft: DraftRecord): Promise<boolean> {
    if (draft.repositoryWorkspaceId === null) return true;
    try {
      await getSandbox(this.env.Sandbox, draft.repositoryWorkspaceId, {
        normalizeId: true,
      }).destroy();
      this.logEvent("sandbox_destroyed", { workspaceId: draft.repositoryWorkspaceId });
      return true;
    } catch {
      this.logEvent("sandbox_destroy_failed", { workspaceId: draft.repositoryWorkspaceId });
      return false;
    }
  }

  private setRepositoryExecutionStep(step: RepositoryExecutionStep): void {
    const draft = this.requireDraft();
    this.ctx.storage.sql.exec(
      `UPDATE draft
       SET repository_operation_phase = ?, repository_execution_step = ?,
           repository_process_id = NULL, repository_step_started_at = NULL,
           repository_step_deadline_at = NULL, updated_at = ?
       WHERE id = ?`,
      repositoryExecutionPhase(step),
      step,
      Date.now(),
      draft.id,
    );
    this.logEvent("repository_operation_phase", {
      phase: repositoryExecutionPhase(step),
      step,
    });
  }

  private readDraft(): DraftRecord | null {
    const row = this.ctx.storage.sql.exec<DraftRow>("SELECT * FROM draft LIMIT 1").toArray()[0];
    return row === undefined ? null : toDraftRecord(row);
  }

  private transition(nextStatus: DraftStatus): DraftRecord {
    const draft = this.requireDraft();
    assertDraftTransition(draft.status, nextStatus);

    this.ctx.storage.sql.exec(
      "UPDATE draft SET status = ?, updated_at = ? WHERE id = ?",
      nextStatus,
      Date.now(),
      draft.id,
    );

    return this.requireDraft();
  }

  private requireDraft(): DraftRecord {
    const draft = this.readDraft();
    if (draft === null) {
      throw new Error("Draft does not exist");
    }
    return draft;
  }

  private requireOrganization(organizationId: string): DraftRecord {
    const draft = this.requireDraft();
    if (draft.organizationId !== organizationId) {
      throw new Error("Draft does not exist");
    }
    return draft;
  }

  private async ensureCleanupAlarm(draft: DraftRecord): Promise<void> {
    if (draft.previewCleanupStatus === "complete") {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    const now = Date.now();
    const scheduledAt = previewLifecycleState(draft, now) === "active"
      ? draft.previewExpiresAt
      : now;
    const currentAlarm = await this.ctx.storage.getAlarm();
    if (currentAlarm === null || currentAlarm > scheduledAt) {
      await this.ctx.storage.setAlarm(scheduledAt);
    }
  }

  private async ensureNextAlarm(draft: DraftRecord): Promise<void> {
    if (
      draft.repositoryOperationStatus === "queued" ||
      draft.repositoryOperationStatus === "running"
    ) {
      await this.ctx.storage.setAlarm(Date.now() + REPOSITORY_POLL_INTERVAL_MS);
      return;
    }
    await this.ensureCleanupAlarm(draft);
  }

  private logEvent(
    event: string,
    details: Record<string, string | number | null> = {},
  ): void {
    const draft = this.readDraft();
    console.log(
      JSON.stringify({
        event,
        organizationId: draft?.organizationId ?? null,
        draftId: draft?.id ?? null,
        timestamp: new Date().toISOString(),
        ...details,
      }),
    );
  }

  private async renderPreview(
    organizationId: string,
    html: string,
    previewHostname: string,
  ): Promise<DraftRecord> {
    const revision = await hashHtml(html);
    const draft = this.requireOrganization(organizationId);
    if (draft.previewCleanupStatus === "in_progress") {
      throw new Error("Preview cleanup is in progress; retry the update after cleanup completes");
    }
    this.transition("building");
    const buildStartedAt = Date.now();
    this.ctx.storage.sql.exec(
      `UPDATE draft
       SET preview_expires_at = ?, preview_revoked_at = NULL,
           preview_cleanup_status = 'scheduled', preview_cleaned_at = NULL,
           updated_at = ?
       WHERE id = ?`,
      buildStartedAt + previewTtlMilliseconds(this.env.PREVIEW_TTL_SECONDS),
      buildStartedAt,
      draft.id,
    );
    this.logEvent("build_started", { revision });

    try {
      const sandbox = getSandbox(this.env.Sandbox, previewSandboxId(organizationId, draft.id), {
        labels: { draftId: draft.id, organizationId },
        normalizeId: true,
      });
      await sandbox.mkdir("/workspace/previews", { recursive: true });
      await sandbox.writeFile(`/workspace/previews/${revision}.html`, html);
      await sandbox.writeFile("/workspace/preview-server.mjs", PREVIEW_SERVER_SOURCE);

      let process = await sandbox.getProcess(PREVIEW_PROCESS_ID);
      if (process === null || !["starting", "running"].includes(process.status)) {
        process = await sandbox.startProcess("node /workspace/preview-server.mjs", {
          autoCleanup: false,
          processId: PREVIEW_PROCESS_ID,
        });
      }
      await process.waitForPort(PREVIEW_PORT, { path: "/healthz", status: 204, timeout: 30_000 });

      const exposed = await sandbox.exposePort(PREVIEW_PORT, {
        hostname: previewHostname,
        name: "landing-preview",
      });
      const previewUrl = buildPreviewUrl(exposed.url, revision, previewHostname);
      const latest = this.requireDraft();
      if (latest.previewRevokedAt !== null || latest.previewCleanedAt !== null) {
        throw new Error("Preview was revoked or cleaned up while the build was running");
      }
      const now = Date.now();
      const previewExpiresAt = now + previewTtlMilliseconds(this.env.PREVIEW_TTL_SECONDS);
      this.ctx.storage.sql.exec(
        `UPDATE draft
         SET status = 'preview_ready', current_revision = ?, preview_url = ?, html = ?,
             preview_expires_at = ?, preview_revoked_at = NULL,
             preview_cleanup_status = 'scheduled', preview_cleaned_at = NULL,
             updated_at = ?
         WHERE id = ?`,
        revision,
        previewUrl,
        html,
        previewExpiresAt,
        now,
        draft.id,
      );
      const rendered = this.requireDraft();
      await this.ensureCleanupAlarm(rendered);
      this.logEvent("build_passed", { revision });
      return rendered;
    } catch (error: unknown) {
      this.ctx.storage.sql.exec(
        "UPDATE draft SET status = 'failed', updated_at = ? WHERE id = ?",
        Date.now(),
        draft.id,
      );
      this.logEvent("build_failed", {
        error: error instanceof Error ? error.message : "Unknown build failure",
        revision,
      });
      throw error;
    }
  }
}

async function hashHtml(html: string): Promise<string> {
  const bytes = new TextEncoder().encode(html);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function toDraftRecord(row: DraftRow): DraftRecord {
  if (!isDraftStatus(row.status)) {
    throw new Error(`Stored draft has an invalid status: ${row.status}`);
  }
  if (row.preview_expires_at === null) {
    throw new Error("Stored draft is missing a preview expiration");
  }
  if (!isPreviewCleanupStatus(row.preview_cleanup_status)) {
    throw new Error(
      `Stored draft has an invalid preview cleanup status: ${row.preview_cleanup_status}`,
    );
  }

  return {
    id: row.id,
    organizationId: row.organization_id,
    createdBy: row.created_by,
    hostname: row.hostname,
    status: row.status,
    baseRevision: row.base_revision,
    currentRevision: row.current_revision,
    approvedRevision: row.approved_revision,
    previewUrl: row.preview_url,
    productionUrl: row.production_url,
    html: row.html,
    repositoryRemoteUrl: row.repository_remote_url,
    repositoryReleaseRef: row.repository_release_ref,
    repositoryBaseSha: row.repository_base_sha,
    repositoryPagePath: row.repository_page_path,
    repositoryWorkspaceId: row.repository_workspace_id,
    repositoryWorkspaceStatus:
      row.repository_workspace_status === null
        ? null
        : requireRepositoryWorkspaceStatus(row.repository_workspace_status),
    repositoryPreparedAt: row.repository_prepared_at,
    repositoryTreeSha: row.repository_tree_sha,
    repositoryChangeOperation: row.repository_change_operation,
    repositoryChangeSummary: row.repository_change_summary,
    repositoryOperationStatus:
      row.repository_operation_status === null
        ? null
        : requireRepositoryOperationStatus(row.repository_operation_status),
    repositoryOperationPhase:
      row.repository_operation_phase === null
        ? null
        : requireRepositoryOperationPhase(row.repository_operation_phase),
    repositoryExecutionStep:
      row.repository_execution_step === null
        ? null
        : requireRepositoryExecutionStep(row.repository_execution_step),
    repositoryProcessId: row.repository_process_id,
    repositoryStepStartedAt: row.repository_step_started_at,
    repositoryStepDeadlineAt: row.repository_step_deadline_at,
    repositoryPendingTreeSha: row.repository_pending_tree_sha,
    repositoryPendingFailure: row.repository_pending_failure,
    repositoryOperationError: row.repository_operation_error,
    repositoryOperationDeadlineAt: row.repository_operation_deadline_at,
    repositoryOperationAttempt: row.repository_operation_attempt,
    repositoryIdempotencyKey: row.repository_idempotency_key,
    previewExpiresAt: row.preview_expires_at,
    previewRevokedAt: row.preview_revoked_at,
    previewCleanupStatus: row.preview_cleanup_status,
    previewCleanedAt: row.preview_cleaned_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function requireRepositoryWorkspaceStatus(value: string) {
  if (!isRepositoryWorkspaceStatus(value)) {
    throw new Error(`Stored draft has an invalid repository workspace status: ${value}`);
  }
  return value;
}

function requireRepositoryOperationStatus(value: string): RepositoryOperationStatus {
  if (!isRepositoryOperationStatus(value)) {
    throw new Error(`Stored draft has an invalid repository operation status: ${value}`);
  }
  return value;
}

function requireRepositoryOperationPhase(value: string): RepositoryOperationPhase {
  if (!isRepositoryOperationPhase(value)) {
    throw new Error(`Stored draft has an invalid repository operation phase: ${value}`);
  }
  return value;
}

function requireRepositoryExecutionStep(value: string): RepositoryExecutionStep {
  if (!isRepositoryExecutionStep(value)) {
    throw new Error(`Stored draft has an invalid repository execution step: ${value}`);
  }
  return value;
}

interface RepositoryProcessSpecification {
  command: string;
  options: ProcessOptions;
  timeout: number;
}

function validationProcessSpecification(
  command: string,
): RepositoryProcessSpecification {
  return {
    command,
    options: {
      cwd: REPOSITORY_WORKSPACE_PATH,
      env: REPOSITORY_VALIDATION_ENVIRONMENT,
    },
    timeout: REPOSITORY_VALIDATION_TIMEOUT_MS,
  };
}

function nextRepositoryExecutionStep(
  step: RepositoryExecutionStep,
): RepositoryExecutionStep | null {
  switch (step) {
    case "checkout":
      return "install";
    case "install":
      return "base_check";
    case "base_check":
      return "base_build";
    case "base_build":
    case "restore":
      return "edit";
    case "edit":
      return "snapshot";
    case "snapshot":
      return "check";
    case "check":
      return "build";
    case "build":
      return "preview_start";
    case "preview_start":
      return "preview_astro_ready";
    case "preview_astro_ready":
      return "preview_proxy";
    case "preview_proxy":
      return "preview_proxy_ready";
    case "preview_proxy_ready":
      return "preview_verify";
    case "preview_verify":
      return "preview_expose";
    case "preview_expose":
    case "failure_restore":
      return null;
  }
}

function parseStoredLandingEdits(serialized: string | null): readonly LandingEditOperation[] {
  if (serialized === null) {
    throw new Error("Stored repository operation is missing its edit batch");
  }
  const parsed: unknown = JSON.parse(serialized);
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.length > 8 ||
    !parsed.every((entry: unknown) => isStoredLandingEdit(entry))
  ) {
    throw new Error("Stored repository operation has an invalid edit batch");
  }
  return parsed as LandingEditOperation[];
}

function isStoredLandingEdit(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null) return false;
  const operation = (entry as Record<string, unknown>)["operation"];
  return (
    typeof operation === "string" &&
    [
      "replace_headline",
      "update_copy",
      "update_cta",
      "update_seo_metadata",
      "replace_image",
      "apply_page_change",
    ].includes(operation)
  );
}
