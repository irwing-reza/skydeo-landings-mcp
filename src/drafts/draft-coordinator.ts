import { DurableObject } from "cloudflare:workers";
import { getSandbox } from "@cloudflare/sandbox";

import {
  assertDraftTransition,
  isDraftStatus,
  type DraftRecord,
  type DraftStatus,
} from "../domain/draft";
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

const PREVIEW_PORT = 4321;
const PREVIEW_PROCESS_ID = "preview-server";
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
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      const columns = this.ctx.storage.sql
        .exec<{ name: string }>("PRAGMA table_info(draft)")
        .toArray();
      if (!columns.some((column) => column.name === "html")) {
        this.ctx.storage.sql.exec("ALTER TABLE draft ADD COLUMN html TEXT NOT NULL DEFAULT ''");
      }
      return Promise.resolve();
    });
  }

  async create(input: CreateDraftInput): Promise<DraftRecord> {
    if (this.readDraft() !== null) {
      throw new Error("Draft already exists");
    }

    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO draft (
        id, organization_id, created_by, hostname, status, base_revision,
        current_revision, approved_revision, preview_url, production_url, html,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'draft', ?, ?, NULL, NULL, NULL, '', ?, ?)`,
      input.id,
      input.organizationId,
      input.createdBy,
      input.hostname,
      input.baseRevision,
      input.baseRevision,
      now,
      now,
    );

    return this.renderPreview(input.organizationId, input.html, input.previewHostname);
  }

  get(organizationId: string): DraftRecord {
    return this.requireOrganization(organizationId);
  }

  async update(input: UpdateDraftInput): Promise<DraftRecord> {
    const draft = this.requireOrganization(input.organizationId);
    if (draft.currentRevision !== input.expectedRevision) {
      throw new Error(
        `Draft revision conflict: expected ${input.expectedRevision}, current ${draft.currentRevision}`,
      );
    }
    return this.renderPreview(input.organizationId, input.html, input.previewHostname);
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

  private async renderPreview(
    organizationId: string,
    html: string,
    previewHostname: string,
  ): Promise<DraftRecord> {
    const draft = this.requireOrganization(organizationId);
    const revision = await hashHtml(html);
    this.transition("building");

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
      const now = Date.now();
      this.ctx.storage.sql.exec(
        `UPDATE draft
         SET status = 'preview_ready', current_revision = ?, preview_url = ?, html = ?, updated_at = ?
         WHERE id = ?`,
        revision,
        previewUrl,
        html,
        now,
        draft.id,
      );
      return this.requireDraft();
    } catch (error: unknown) {
      this.ctx.storage.sql.exec(
        "UPDATE draft SET status = 'failed', updated_at = ? WHERE id = ?",
        Date.now(),
        draft.id,
      );
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
