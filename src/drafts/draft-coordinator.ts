import { DurableObject } from "cloudflare:workers";
import { getSandbox } from "@cloudflare/sandbox";

import {
  assertDraftTransition,
  isDraftStatus,
  isRepositoryWorkspaceStatus,
  type DraftRecord,
  type DraftStatus,
} from "../domain/draft";
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
  installAndValidateRepository,
  prepareRepositoryCheckout,
  REPOSITORY_PREVIEW_COMMAND,
  replaceRepositoryHeadline,
  repositoryTreeRevision,
  repositoryWorkspaceConfig,
  RepositoryEditError,
  RepositoryValidationError,
  restoreRepositoryTree,
  snapshotRepositoryTree,
  validateRepositoryChanges,
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
> & { headline: string; pagePath: string; previewHostname: string };

export interface UpdateRepositoryDraftInput {
  expectedRevision: string;
  headline: string;
  organizationId: string;
  previewHostname: string;
}

export interface RepositoryDraftMutationResult {
  draft: DraftRecord;
  changeSummary: string;
  validation: {
    status: "passed" | "failed";
    checks: readonly string[];
    summary: string | null;
  };
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
    await this.ensureCleanupAlarm(draft);
    return draft;
  }

  async createRepositoryDraft(
    input: CreateRepositoryDraftInput,
  ): Promise<RepositoryDraftMutationResult> {
    if (this.readDraft() !== null) {
      throw new Error("Draft already exists");
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
        repository_change_summary, preview_expires_at, preview_revoked_at,
        preview_cleanup_status, preview_cleaned_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'draft', ?, ?, NULL, NULL, NULL, '', ?, ?, ?, ?, ?,
        'preparing', NULL, NULL, NULL, NULL, ?, NULL, 'scheduled', NULL, ?, ?)`,
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
      previewExpiresAt,
      now,
      now,
    );
    this.logEvent("repository_workspace_preparing", { workspaceId });

    const sandbox = getSandbox(this.env.Sandbox, workspaceId, {
      labels: { draftId: input.id, organizationId: input.organizationId },
      normalizeId: true,
    });

    try {
      await prepareRepositoryCheckout(
        sandbox,
        config,
        this.env.REPOSITORY_CHECKOUT_TOKEN,
      );
      await installAndValidateRepository(sandbox);
      const preparedAt = Date.now();
      this.ctx.storage.sql.exec(
        `UPDATE draft
         SET repository_workspace_status = 'ready', repository_prepared_at = ?,
             updated_at = ?
         WHERE id = ?`,
        preparedAt,
        preparedAt,
        input.id,
      );
      const draft = this.requireDraft();
      await this.ensureCleanupAlarm(draft);
      this.logEvent("repository_workspace_ready", {
        revision: config.baseSha,
        workspaceId,
      });
      this.transition("building");
      const treeSha = await replaceRepositoryHeadline(
        sandbox,
        input.pagePath,
        input.headline,
      );
      const validation = await validateRepositoryChanges(sandbox);
      const revision = await repositoryTreeRevision(config.baseSha, treeSha);
      const changeSummary = `Replaced the headline on ${input.hostname} with “${input.headline}”.`;
      const rendered = await this.renderRepositoryPreview(
        input.organizationId,
        input.previewHostname,
        revision,
        treeSha,
        changeSummary,
      );
      return {
        draft: rendered,
        changeSummary,
        validation: {
          status: "passed",
          checks: validation.checks,
          summary: "The canonical repository checks passed.",
        },
      };
    } catch (error: unknown) {
      let cleanupComplete = false;
      try {
        await sandbox.destroy();
        cleanupComplete = true;
      } catch {
        // The persisted failed cleanup state schedules an alarm retry.
      }
      const failedAt = Date.now();
      this.ctx.storage.sql.exec(
        `UPDATE draft
         SET status = 'failed', repository_workspace_status = 'failed',
             preview_expires_at = ?, preview_cleanup_status = ?,
             preview_cleaned_at = ?, updated_at = ?
         WHERE id = ?`,
        failedAt,
        cleanupComplete ? "complete" : "failed",
        cleanupComplete ? failedAt : null,
        failedAt,
        input.id,
      );
      const failed = this.requireDraft();
      await this.ensureCleanupAlarm(failed);
      this.logEvent("repository_workspace_failed", {
        cleanupComplete: cleanupComplete ? 1 : 0,
        error: error instanceof Error ? error.message : "Unknown checkout failure",
        workspaceId,
      });
      return {
        draft: failed,
        changeSummary: "No repository revision was created.",
        validation: {
          status: "failed",
          checks: ["npm run check", "npm run build"],
          summary:
            error instanceof RepositoryValidationError || error instanceof RepositoryEditError
              ? error.message
              : "Repository workspace preparation failed; the disposable workspace was destroyed.",
        },
      };
    }
  }

  async updateRepositoryDraft(
    input: UpdateRepositoryDraftInput,
  ): Promise<RepositoryDraftMutationResult> {
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
    const sandbox = getSandbox(this.env.Sandbox, draft.repositoryWorkspaceId, {
      labels: { draftId: draft.id, organizationId: draft.organizationId },
      normalizeId: true,
    });
    await prepareRepositoryCheckout(sandbox, config, this.env.REPOSITORY_CHECKOUT_TOKEN);
    const actualTreeSha = await snapshotRepositoryTree(
      sandbox,
      draft.repositoryPagePath,
    );
    if (actualTreeSha !== draft.repositoryTreeSha) {
      throw new Error("The repository workspace does not match the stored draft revision");
    }

    this.transition("building");
    try {
      const treeSha = await replaceRepositoryHeadline(
        sandbox,
        draft.repositoryPagePath,
        input.headline,
      );
      const validation = await validateRepositoryChanges(sandbox);
      const revision = await repositoryTreeRevision(draft.repositoryBaseSha, treeSha);
      const changeSummary = `Replaced the headline on ${draft.hostname} with “${input.headline}”.`;
      const rendered = await this.renderRepositoryPreview(
        input.organizationId,
        input.previewHostname,
        revision,
        treeSha,
        changeSummary,
      );
      return {
        draft: rendered,
        changeSummary,
        validation: {
          status: "passed",
          checks: validation.checks,
          summary: "The canonical repository checks passed.",
        },
      };
    } catch (error: unknown) {
      try {
        await restoreRepositoryTree(
          sandbox,
          draft.repositoryPagePath,
          draft.repositoryTreeSha,
        );
      } catch {
        let cleanupComplete = false;
        try {
          await sandbox.destroy();
          cleanupComplete = true;
        } catch {
          // Failed destruction is retried by the existing cleanup alarm.
        }
        const failedAt = Date.now();
        this.ctx.storage.sql.exec(
          `UPDATE draft
           SET status = 'failed', repository_workspace_status = 'failed',
               preview_expires_at = ?, preview_cleanup_status = ?,
               preview_cleaned_at = ?, preview_url = NULL, updated_at = ?
           WHERE id = ?`,
          failedAt,
          cleanupComplete ? "complete" : "failed",
          cleanupComplete ? failedAt : null,
          failedAt,
          draft.id,
        );
        const failed = this.requireDraft();
        await this.ensureCleanupAlarm(failed);
        return {
          draft: failed,
          changeSummary: "No repository revision was saved and the workspace was retired.",
          validation: {
            status: "failed",
            checks: ["npm run check", "npm run build"],
            summary:
              "The previous repository tree could not be restored safely; start a new update.",
          },
        };
      }
      this.ctx.storage.sql.exec(
        "UPDATE draft SET status = 'preview_ready', updated_at = ? WHERE id = ?",
        Date.now(),
        draft.id,
      );
      return {
        draft: this.requireDraft(),
        changeSummary: "The requested edit was not saved; the previous revision remains active.",
        validation: {
          status: "failed",
          checks: ["npm run check", "npm run build"],
          summary:
            error instanceof RepositoryValidationError || error instanceof RepositoryEditError
              ? error.message
              : "The repository preview could not be updated; the previous revision was restored.",
        },
      };
    }
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
         SET preview_revoked_at = ?, preview_cleanup_status = 'scheduled', updated_at = ?
         WHERE id = ?`,
        now,
        now,
        draft.id,
      );
      this.logEvent("preview_revoked", { actorId, revision: draft.currentRevision });
    }

    const revoked = this.requireDraft();
    await this.ensureCleanupAlarm(revoked);
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
    if (previewLifecycleState(draft) === "expired") {
      this.logEvent("preview_expired", { revision: draft.currentRevision });
    }
    await this.cleanupPreview(draft.organizationId);
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

  private async renderRepositoryPreview(
    organizationId: string,
    previewHostname: string,
    revision: string,
    treeSha: string,
    changeSummary: string,
  ): Promise<DraftRecord> {
    const draft = this.requireOrganization(organizationId);
    if (draft.status !== "building" || draft.repositoryWorkspaceId === null) {
      throw new Error("Repository preview cannot start before a validated edit");
    }
    const sandbox = getSandbox(this.env.Sandbox, draft.repositoryWorkspaceId, {
      labels: { draftId: draft.id, organizationId },
      normalizeId: true,
    });

    let astro = await sandbox.getProcess(REPOSITORY_PREVIEW_PROCESS_ID);
    if (astro === null || !["starting", "running"].includes(astro.status)) {
      astro = await sandbox.startProcess(REPOSITORY_PREVIEW_COMMAND, {
        autoCleanup: false,
        cwd: "/workspace/repository",
        env: { CI: "true", NO_COLOR: "1" },
        processId: REPOSITORY_PREVIEW_PROCESS_ID,
      });
    }
    await astro.waitForPort(4322, { mode: "tcp", timeout: 30_000 });

    let proxy = await sandbox.getProcess(REPOSITORY_PREVIEW_PROXY_PROCESS_ID);
    if (proxy === null || !["starting", "running"].includes(proxy.status)) {
      proxy = await sandbox.startProcess("/usr/local/bin/repository-preview-proxy", {
        autoCleanup: false,
        env: { REPOSITORY_PREVIEW_HOSTNAME: draft.hostname },
        processId: REPOSITORY_PREVIEW_PROXY_PROCESS_ID,
      });
    }
    await proxy.waitForPort(PREVIEW_PORT, {
      path: "/__mcp_healthz",
      status: 204,
      timeout: 30_000,
    });

    const exposed = await sandbox.exposePort(PREVIEW_PORT, {
      hostname: previewHostname,
      name: "landing-preview",
    });
    const previewUrl = buildPreviewUrl(exposed.url, revision, previewHostname);
    const now = Date.now();
    const previewExpiresAt = now + previewTtlMilliseconds(this.env.PREVIEW_TTL_SECONDS);
    this.ctx.storage.sql.exec(
      `UPDATE draft
       SET status = 'preview_ready', current_revision = ?, preview_url = ?,
           repository_tree_sha = ?, repository_change_operation = 'replace_headline',
           repository_change_summary = ?, preview_expires_at = ?,
           preview_revoked_at = NULL, preview_cleanup_status = 'scheduled',
           preview_cleaned_at = NULL, updated_at = ?
       WHERE id = ?`,
      revision,
      previewUrl,
      treeSha,
      changeSummary,
      previewExpiresAt,
      now,
      draft.id,
    );
    const rendered = this.requireDraft();
    await this.ensureCleanupAlarm(rendered);
    this.logEvent("repository_preview_ready", { revision, treeSha });
    return rendered;
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
