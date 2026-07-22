import { DurableObject } from "cloudflare:workers";
import { getSandbox } from "@cloudflare/sandbox";

import {
  assertDraftTransition,
  isDraftStatus,
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

export interface PreviewAuthorization {
  allowed: boolean;
  state: PreviewLifecycleState;
}

const PREVIEW_PORT = 4321;
const PREVIEW_PROCESS_ID = "preview-server";
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

  const revision = decodeURIComponent(new URL(request.url ?? "/", "http://preview").pathname.slice(1));
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
    revision: string,
  ): Promise<PreviewAuthorization> {
    await this.ensureCleanupAlarm(this.requireOrganization(organizationId));
    const draft = this.requireOrganization(organizationId);
    const state = previewLifecycleState(draft);
    if (state === "active") {
      this.logEvent("preview_opened", { revision });
      return { allowed: true, state };
    }

    this.logEvent(`preview_${state}`, { revision });
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
    previewExpiresAt: row.preview_expires_at,
    previewRevokedAt: row.preview_revoked_at,
    previewCleanupStatus: row.preview_cleanup_status,
    previewCleanedAt: row.preview_cleaned_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
