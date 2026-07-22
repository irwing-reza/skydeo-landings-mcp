const LOCAL_PREVIEW_PATH = "/__preview/";

export function buildPreviewUrl(
  exposedUrl: string,
  revision: string,
  previewHostname: string,
): string {
  const exposed = new URL(exposedUrl);
  const exposedHostLabel = exposed.hostname.split(".")[0];
  if (exposedHostLabel === undefined) {
    throw new Error("Sandbox returned an invalid preview URL");
  }

  if (isLocalPreviewHostname(previewHostname)) {
    return `http://${previewHostname}${LOCAL_PREVIEW_PATH}${exposedHostLabel}/${revision}`;
  }

  return `${exposedUrl.replace(/\/$/, "")}/${revision}`;
}

export interface LocalPreviewRoute {
  port: number;
  revision: string;
  sandboxId: string;
  token: string;
}

export function isProductionPreviewHostname(hostname: string, previewHostname: string): boolean {
  const normalizedHostname = hostname.toLowerCase().replace(/\.$/, "");
  const normalizedPreviewHostname = previewHostname
    .split(":")[0]
    ?.toLowerCase()
    .replace(/\.$/, "");
  if (!normalizedPreviewHostname || isLocalPreviewHostname(normalizedPreviewHostname)) {
    return false;
  }

  const suffix = `.${normalizedPreviewHostname}`;
  if (!normalizedHostname.endsWith(suffix)) {
    return false;
  }

  const label = normalizedHostname.slice(0, -suffix.length);
  return label.length > 0 && !label.includes(".");
}

export function parseLocalPreviewRoute(url: URL): LocalPreviewRoute | null {
  if (!url.pathname.startsWith(LOCAL_PREVIEW_PATH)) {
    return null;
  }

  const [exposedHostLabel, revision, ...extraSegments] = url.pathname
    .slice(LOCAL_PREVIEW_PATH.length)
    .split("/");
  if (
    exposedHostLabel === undefined ||
    exposedHostLabel.length === 0 ||
    revision === undefined ||
    revision.length === 0 ||
    extraSegments.length > 0
  ) {
    return null;
  }

  const firstHyphen = exposedHostLabel.indexOf("-");
  const lastHyphen = exposedHostLabel.lastIndexOf("-");
  if (firstHyphen <= 0 || lastHyphen <= firstHyphen) {
    return null;
  }

  const port = Number.parseInt(exposedHostLabel.slice(0, firstHyphen), 10);
  const sandboxId = exposedHostLabel.slice(firstHyphen + 1, lastHyphen);
  const token = exposedHostLabel.slice(lastHyphen + 1);
  if (
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65_535 ||
    sandboxId.length === 0 ||
    !/^[a-z0-9-]+$/.test(sandboxId) ||
    token.length === 0 ||
    token.length > 16 ||
    !/^[a-z0-9_]+$/.test(token) ||
    !/^[a-f0-9]{64}$/.test(revision)
  ) {
    return null;
  }

  return { port, revision, sandboxId, token };
}

function isLocalPreviewHostname(hostname: string): boolean {
  const host = hostname.split(":")[0];
  return host === "localhost" || host === "127.0.0.1";
}
