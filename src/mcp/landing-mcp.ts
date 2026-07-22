import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";

import type { DraftRecord } from "../domain/draft";
import {
  permissionForLandingIntent,
  type LandingPermission,
} from "../domain/landing-authorization";
import {
  inspectLandingDraft,
  planInitialLandingRequest,
  unavailableDraftOperation,
} from "../domain/manage-landing";
import { classifyLandingIntent } from "../domain/landing-intent";
import type { ManageLandingRequest, ManageLandingResult } from "../domain/landing-workflow";
import { previewLifecycleState } from "../domain/preview-lifecycle";
import { draftObjectName } from "../drafts/draft-object-name";
import { LOCAL_CANDIDATE_LANDING_SNAPSHOT } from "../repository/page-catalog";

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
      "manage_landing",
      {
        description:
          "Resolve and inspect the unified Skydeo landing-page workflow. Initial discovery and status reads are available; repository-backed edits fail closed until the canonical repository boundary is configured. This tool never confirms or completes publishing.",
        inputSchema: {
          request: z.string().trim().min(1).max(10_000),
          draft_id: z.uuid().optional(),
          expected_revision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
        },
      },
      async (input) => {
        const request: ManageLandingRequest = {
          request: input.request,
          ...(input.draft_id === undefined ? {} : { draft_id: input.draft_id }),
          ...(input.expected_revision === undefined
            ? {}
            : { expected_revision: input.expected_revision }),
        };
        const intent = classifyLandingIntent(request);
        const auth = this.requirePermission(permissionForLandingIntent(intent));

        try {
          if (input.draft_id === undefined) {
            return workflowResult(
              planInitialLandingRequest(request, LOCAL_CANDIDATE_LANDING_SNAPSHOT),
            );
          }

          const draft = await this.env.DRAFTS.getByName(
            draftObjectName(auth.organizationId, input.draft_id),
          ).get(auth.organizationId);
          if (intent === "inspect_status") {
            return workflowResult(inspectLandingDraft(draft));
          }
          if (
            input.expected_revision !== undefined &&
            input.expected_revision !== draft.currentRevision
          ) {
            throw new Error(
              `Draft revision conflict: expected ${input.expected_revision}, current ${draft.currentRevision}`,
            );
          }
          return workflowResult(unavailableDraftOperation(request, draft));
        } catch (error: unknown) {
          return toolError(error);
        }
      },
    );

    this.server.registerTool(
      "confirm_publish",
      {
        description:
          "Confirm one previously requested, immutable landing revision for publishing. This is a separate landings:publish security boundary and currently fails closed because publish confirmation records and repository publishing are not configured.",
        inputSchema: {
          draft_id: z.uuid(),
          expected_revision: z.string().regex(/^[a-f0-9]{64}$/),
          confirmation_token: z.string().trim().min(32).max(4_096),
        },
      },
      () => {
        this.requirePermission("landings:publish");
        return Promise.resolve(
          toolError(
            new Error(
              "Publish confirmation is unavailable; no confirmation record was consumed and no repository or production action occurred",
            ),
          ),
        );
      },
    );

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
                    manageLanding: true,
                    repositoryBackedEditing: false,
                    confirmPublish: false,
                    createDraft: true,
                    getDraft: true,
                    updateDraft: true,
                    preview: true,
                    revokePreview: true,
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
    this.server.registerTool(
      "revoke_preview",
      {
        description:
          "Revoke a draft preview immediately and schedule idempotent cleanup of its Sandbox container. This never publishes.",
        inputSchema: { draft_id: z.uuid() },
      },
      async ({ draft_id: draftId }) => {
        const auth = this.requirePermission("landings:write");
        try {
          const draft = await this.env.DRAFTS.getByName(
            draftObjectName(auth.organizationId, draftId),
          ).revokePreview(auth.organizationId, auth.claims.sub);
          return draftResult(draft);
        } catch (error: unknown) {
          return toolError(error);
        }
      },
    );
    return Promise.resolve();
  }

  private requirePermission(permission: LandingPermission): AuthContext {
    const authMode: string = this.env.MCP_AUTH_MODE;
    if (authMode === "local") {
      return {
        claims: { email: "local@skydeo.invalid", name: "Local developer", sub: "local-dev" },
        organizationId: this.env.ORGANIZATION_ID,
        permissions: ["landings:read", "landings:write", "landings:publish"],
      };
    }

    const auth = this.props;
    if (auth === undefined || !auth.permissions.includes(permission)) {
      throw new Error(`Missing required permission: ${permission}`);
    }
    return auth;
  }
}

function workflowResult(result: ManageLandingResult) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    structuredContent: { ...result },
  };
}

function draftResult(draft: DraftRecord) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(toPublicDraft(draft), null, 2) }],
    structuredContent: toPublicDraft(draft),
  };
}

function toPublicDraft(draft: DraftRecord) {
  const previewState = previewLifecycleState(draft);
  return {
    base_revision: draft.baseRevision,
    created_at: new Date(draft.createdAt).toISOString(),
    current_revision: draft.currentRevision,
    draft_id: draft.id,
    hostname: draft.hostname,
    preview_state: previewState,
    preview_url: previewState === "active" ? draft.previewUrl : null,
    expires_at: new Date(draft.previewExpiresAt).toISOString(),
    revoked_at:
      draft.previewRevokedAt === null ? null : new Date(draft.previewRevokedAt).toISOString(),
    cleanup_status: draft.previewCleanupStatus,
    cleaned_up_at:
      draft.previewCleanedAt === null ? null : new Date(draft.previewCleanedAt).toISOString(),
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
