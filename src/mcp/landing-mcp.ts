import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";

import type { DraftRecord } from "../domain/draft";

export interface AuthContext extends Record<string, unknown> {
  claims: {
    sub: string;
    name: string;
    email: string;
  };
  organizationId: string;
  permissions: string[];
}

export class LandingMcp extends McpAgent<Env, Record<string, never>, AuthContext> {
  server = new McpServer({
    name: "Skydeo Landing MCP",
    version: "0.1.0",
  });

  override initialState: Record<string, never> = {};

  init(): Promise<void> {
    this.server.registerTool(
      "get_service_status",
      {
        description:
          "Report which Skydeo landing workflow capabilities are currently available. This tool never changes a draft or production.",
      },
      () =>
        Promise.resolve({
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  service: "skydeo-landing-mcp",
                  phase: "draft-preview-loop",
                  capabilities: {
                    status: true,
                    createDraft: true,
                    getDraft: true,
                    updateDraft: true,
                    preview: true,
                    publish: false,
                  },
                },
                null,
                2,
              ),
            },
          ],
        }),
    );

    this.server.registerTool(
      "create_draft",
      {
        description:
          "Create an isolated landing-page draft and return its immutable first revision and preview URL. This never publishes to production.",
        inputSchema: {
          hostname: z.string().trim().min(1).max(253),
          base_revision: z.string().trim().min(1).max(200),
          html: z.string().min(1).max(500_000),
        },
      },
      async ({ hostname, base_revision: baseRevision, html }) => {
        const auth = this.requirePermission("landings:write");
        const id = crypto.randomUUID();
        try {
          const draft = await this.env.DRAFTS.getByName(draftObjectName(auth.organizationId, id)).create({
            baseRevision,
            createdBy: auth.claims.sub,
            hostname,
            html,
            id,
            organizationId: auth.organizationId,
            previewHostname: this.env.PREVIEW_HOSTNAME,
          });
          return draftResult(draft);
        } catch (error: unknown) {
          return toolError(error);
        }
      },
    );

    this.server.registerTool(
      "get_draft",
      {
        description:
          "Get the current state, immutable revision, and preview URL for a draft in the authenticated organization.",
        inputSchema: { draft_id: z.uuid() },
      },
      async ({ draft_id: draftId }) => {
        const auth = this.requirePermission("landings:read");
        try {
          const draft = await this.env.DRAFTS.getByName(
            draftObjectName(auth.organizationId, draftId),
          ).get(auth.organizationId);
          return draftResult(draft);
        } catch (error: unknown) {
          return toolError(error);
        }
      },
    );

    this.server.registerTool(
      "update_draft",
      {
        description:
          "Replace a draft's HTML, creating a new immutable revision and preview URL. expected_revision prevents overwriting a concurrent edit. This never publishes.",
        inputSchema: {
          draft_id: z.uuid(),
          expected_revision: z.string().regex(/^[a-f0-9]{64}$/),
          html: z.string().min(1).max(500_000),
        },
      },
      async ({ draft_id: draftId, expected_revision: expectedRevision, html }) => {
        const auth = this.requirePermission("landings:write");
        try {
          const draft = await this.env.DRAFTS.getByName(
            draftObjectName(auth.organizationId, draftId),
          ).update({
            expectedRevision,
            html,
            organizationId: auth.organizationId,
            previewHostname: this.env.PREVIEW_HOSTNAME,
          });
          return draftResult(draft);
        } catch (error: unknown) {
          return toolError(error);
        }
      },
    );
    return Promise.resolve();
  }

  private requirePermission(permission: "landings:read" | "landings:write"): AuthContext {
    const authMode: string = this.env.MCP_AUTH_MODE;
    if (authMode === "local") {
      return {
        claims: { email: "local@skydeo.invalid", name: "Local developer", sub: "local-dev" },
        organizationId: "skydeo",
        permissions: ["landings:read", "landings:write"],
      };
    }

    const auth = this.props;
    if (auth === undefined || !auth.permissions.includes(permission)) {
      throw new Error(`Missing required permission: ${permission}`);
    }
    return auth;
  }
}

function draftObjectName(organizationId: string, draftId: string): string {
  return `draft:${organizationId}:${draftId}`;
}

function draftResult(draft: DraftRecord) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(toPublicDraft(draft), null, 2) }],
    structuredContent: toPublicDraft(draft),
  };
}

function toPublicDraft(draft: DraftRecord) {
  return {
    base_revision: draft.baseRevision,
    created_at: new Date(draft.createdAt).toISOString(),
    current_revision: draft.currentRevision,
    draft_id: draft.id,
    hostname: draft.hostname,
    preview_url: draft.previewUrl,
    production_url: null,
    publish_available: false,
    status: draft.status,
    updated_at: new Date(draft.updatedAt).toISOString(),
  };
}

function toolError(error: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: error instanceof Error ? error.message : "Draft operation failed",
      },
    ],
    isError: true,
  };
}
