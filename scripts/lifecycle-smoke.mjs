import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const DEFAULT_MCP_URL = "http://localhost:8787/mcp";
const POLL_INTERVAL_MS = 1_000;
const CLEANUP_TIMEOUT_MS = 90_000;

const options = parseArguments(process.argv.slice(2));
const mcpUrl = new URL(options.mcpUrl);
const isLocal = ["localhost", "127.0.0.1", "[::1]"].includes(mcpUrl.hostname);

if (!isLocal && process.env.ALLOW_REMOTE_LIFECYCLE_SMOKE !== "1") {
  throw new Error(
    "Refusing to mutate a remote service. Set ALLOW_REMOTE_LIFECYCLE_SMOKE=1 after explicit authorization.",
  );
}

const requestHeaders = new Headers();
if (process.env.LIFECYCLE_SMOKE_BEARER_TOKEN) {
  requestHeaders.set(
    "authorization",
    `Bearer ${process.env.LIFECYCLE_SMOKE_BEARER_TOKEN}`,
  );
}

const transport = new StreamableHTTPClientTransport(mcpUrl, {
  requestInit: { headers: requestHeaders },
});
const client = new Client({ name: "skydeo-lifecycle-smoke", version: "0.1.0" });

try {
  await client.connect(transport);
  if (!isLocal) {
    await verifyRepositoryWorkspacePreflight();
  }
  report("connected", { target: mcpUrl.origin, scenario: options.scenario });

  if (options.scenario === "all" || options.scenario === "revoked") {
    await verifyRevocationLifecycle();
  }
  if (options.scenario === "all" || options.scenario === "expired") {
    await verifyExpirationLifecycle();
  }

  report("smoke_passed", { scenario: options.scenario });
} finally {
  await transport.close();
}

async function verifyRepositoryWorkspacePreflight() {
  const result = await client.callTool({ name: "get_service_status", arguments: {} });
  assert(!result.isError, "repository-workspace preflight could not read service status");
  const status = result.structuredContent;
  assert(
    status && typeof status === "object" && status.service === "skydeo-landing-mcp",
    "repository-workspace preflight received an unexpected service",
  );
  assert(
    status.capabilities?.repositoryBackedEditing === true,
    "remote lifecycle smoke requires repository-backed editing",
  );
  assert(
    status.capabilities?.repositoryWorkspaceCleanup === true,
    "remote lifecycle smoke requires repository-workspace cleanup",
  );
  assert(
    status.capabilities?.publish === false && status.capabilities?.confirmPublish === false,
    "remote lifecycle smoke requires publishing to remain disabled",
  );
  report("repository_workspace_preflight_passed");
}

async function verifyRevocationLifecycle() {
  const marker = `revoked-${crypto.randomUUID()}`;
  const draft = await createDraft(marker);
  assert(draft.preview_state === "active", "new preview should be active");
  assert(draft.cleanup_status === "scheduled", "new preview cleanup should be scheduled");
  await assertPreview(draft.preview_url, marker, 200);
  report("active_preview_verified", { draftId: draft.draft_id });

  const revoked = await callDraftTool("revoke_preview", { draft_id: draft.draft_id });
  assert(
    ["revoked", "cleaned_up"].includes(revoked.preview_state),
    `revoked preview returned unexpected state ${String(revoked.preview_state)}`,
  );
  await assertPreview(draft.preview_url, marker, 410);
  report("revoked_preview_failed_closed", { draftId: draft.draft_id });

  const cleaned = await waitForCleanup(draft.draft_id);
  assert(cleaned.preview_url === null, "cleaned preview URL should be cleared");
  assert(cleaned.cleaned_up_at !== null, "cleaned preview should record cleaned_up_at");
  report("revoked_container_cleaned", { draftId: draft.draft_id });

  const repeated = await callDraftTool("revoke_preview", { draft_id: draft.draft_id });
  assert(repeated.preview_state === "cleaned_up", "repeated revoke should remain cleaned_up");
  assert(repeated.cleaned_up_at === cleaned.cleaned_up_at, "repeated cleanup must be idempotent");
  await assertPreview(draft.preview_url, marker, 410);
  report("repeated_cleanup_verified", { draftId: draft.draft_id });
}

async function verifyExpirationLifecycle() {
  const marker = `expired-${crypto.randomUUID()}`;
  const draft = await createDraft(marker);
  assert(draft.preview_state === "active", "new expiry preview should be active");
  await assertPreview(draft.preview_url, marker, 200);

  const expiresAt = Date.parse(draft.expires_at);
  assert(Number.isFinite(expiresAt), "draft should return a valid expires_at timestamp");
  const waitMs = Math.max(0, expiresAt - Date.now() + 250);
  report("waiting_for_expiration_alarm", { draftId: draft.draft_id, waitMs });
  await delay(waitMs);

  const unavailable = await fetchPreview(draft.preview_url);
  assert(unavailable.status === 410, `expired preview should return 410, got ${unavailable.status}`);
  const unavailableBody = await unavailable.json();
  assert(
    unavailableBody.state === "expired" || unavailableBody.state === "cleaned_up",
    `expired preview returned unexpected state ${String(unavailableBody.state)}`,
  );
  report("expired_preview_failed_closed", {
    draftId: draft.draft_id,
    observedState: unavailableBody.state,
  });

  await waitForCleanup(draft.draft_id);
  report("expired_container_cleaned", { draftId: draft.draft_id });
}

async function createDraft(marker) {
  return callDraftTool("create_draft", {
    hostname: "lifecycle-smoke.skydeo.invalid",
    base_revision: `smoke-${crypto.randomUUID()}`,
    html: `<!doctype html><html><body><main>${marker}</main></body></html>`,
  });
}

async function waitForCleanup(draftId) {
  const deadline = Date.now() + CLEANUP_TIMEOUT_MS;
  let latest;
  while (Date.now() < deadline) {
    latest = await callDraftTool("get_draft", { draft_id: draftId });
    if (latest.preview_state === "cleaned_up" && latest.cleanup_status === "complete") {
      return latest;
    }
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(
    `Timed out waiting for cleanup of ${draftId}; last state was ${JSON.stringify(latest)}`,
  );
}

async function callDraftTool(name, args) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) {
    const message = result.content.find((item) => item.type === "text")?.text;
    throw new Error(`${name} failed: ${message ?? "unknown tool error"}`);
  }
  assert(
    result.structuredContent && typeof result.structuredContent === "object",
    `${name} did not return structured draft content`,
  );
  return result.structuredContent;
}

async function assertPreview(previewUrl, marker, expectedStatus) {
  assert(typeof previewUrl === "string", "draft should return a preview URL");
  const response = await fetchPreview(previewUrl);
  assert(
    response.status === expectedStatus,
    `preview should return ${expectedStatus}, got ${response.status}`,
  );
  if (expectedStatus === 200) {
    const body = await response.text();
    assert(body.includes(marker), "active preview should contain its unique marker");
  }
}

function fetchPreview(previewUrl) {
  const headers = new Headers();
  if (process.env.PREVIEW_ACCESS_CLIENT_ID) {
    headers.set("cf-access-client-id", process.env.PREVIEW_ACCESS_CLIENT_ID);
  }
  if (process.env.PREVIEW_ACCESS_CLIENT_SECRET) {
    headers.set("cf-access-client-secret", process.env.PREVIEW_ACCESS_CLIENT_SECRET);
  }
  return fetch(previewUrl, { headers, redirect: "manual" });
}

function parseArguments(args) {
  let mcpUrl = DEFAULT_MCP_URL;
  let scenario = "all";
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--mcp-url") {
      mcpUrl = requiredValue(args, ++index, argument);
    } else if (argument === "--scenario") {
      scenario = requiredValue(args, ++index, argument);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!["all", "revoked", "expired"].includes(scenario)) {
    throw new Error("--scenario must be all, revoked, or expired");
  }
  return { mcpUrl, scenario };
}

function requiredValue(args, index, flag) {
  const value = args[index];
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function report(event, details = {}) {
  console.log(JSON.stringify({ event, timestamp: new Date().toISOString(), ...details }));
}
