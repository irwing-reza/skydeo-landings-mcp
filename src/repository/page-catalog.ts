export interface LandingRepositorySnapshot {
  baseDomain: string;
  sourcePaths: readonly string[];
  registeredHostnames: readonly string[];
  pageNames?: Readonly<Record<string, string>>;
  aliases?: Readonly<Record<string, readonly string[]>>;
}

export interface LandingPageIdentity {
  name: string;
  hostname: string;
  subdomain: string;
  pathname: string;
  production_url: string | null;
  source_path: string;
  production_registered: boolean;
}

export type PageResolution =
  | { status: "resolved"; page: LandingPageIdentity }
  | { status: "ambiguous"; pages: readonly LandingPageIdentity[] }
  | { status: "not_found"; pages: readonly [] };

interface CatalogEntry {
  page: LandingPageIdentity;
  aliases: readonly string[];
}

const DOMAIN_PAGE_PATTERN = /^src\/domains\/([^/]+)\/pages\/(.+)\.astro$/;

export function discoverLandingPages(
  snapshot: LandingRepositorySnapshot,
): LandingPageIdentity[] {
  const registered = new Set(
    snapshot.registeredHostnames.map((hostname) => normalizeHostname(hostname)),
  );
  const pages: LandingPageIdentity[] = [];

  for (const sourcePath of snapshot.sourcePaths) {
    const match = DOMAIN_PAGE_PATTERN.exec(sourcePath);
    if (match === null) continue;
    const [, subdomain, routeFile] = match;
    if (subdomain === undefined || routeFile === undefined) continue;

    const hostname = `${subdomain}.${snapshot.baseDomain}`.toLowerCase();
    const pathname = routeFile === "index" ? "/" : `/${routeFile}`;
    const productionRegistered = registered.has(hostname);
    pages.push({
      name: snapshot.pageNames?.[subdomain] ?? humanize(subdomain),
      hostname,
      subdomain,
      pathname,
      production_url: productionRegistered ? `https://${hostname}${pathname}` : null,
      source_path: sourcePath,
      production_registered: productionRegistered,
    });
  }

  return pages.sort((left, right) => left.source_path.localeCompare(right.source_path));
}

export function resolveLandingPage(
  reference: string,
  snapshot: LandingRepositorySnapshot,
): PageResolution {
  const entries = catalogEntries(snapshot);
  const trimmed = reference.trim();
  const lowered = trimmed.toLowerCase();

  const matchers: Array<(entry: CatalogEntry) => boolean> = [
    (entry) => entry.page.production_url !== null && containsExactUrl(trimmed, entry.page.production_url),
    (entry) => containsTerm(lowered, entry.page.hostname),
    (entry) => containsTerm(lowered, entry.page.subdomain),
    (entry) => entry.aliases.some((alias) => containsTerm(lowered, alias)),
    (entry) => containsTerm(lowered, entry.page.source_path.toLowerCase()),
  ];

  for (const matches of matchers) {
    const pages = entries.filter(matches).map((entry) => entry.page);
    if (pages.length === 1 && pages[0] !== undefined) {
      return { status: "resolved", page: pages[0] };
    }
    if (pages.length > 1) {
      return { status: "ambiguous", pages };
    }
  }
  return { status: "not_found", pages: [] };
}

export function findOccupiedRoute(
  hostname: string,
  pathname: string,
  snapshot: LandingRepositorySnapshot,
): LandingPageIdentity | null {
  const normalizedHostname = normalizeHostname(hostname);
  const normalizedPathname = normalizePathname(pathname);
  return (
    discoverLandingPages(snapshot).find(
      (page) =>
        page.hostname === normalizedHostname && page.pathname === normalizedPathname,
    ) ?? null
  );
}

function catalogEntries(snapshot: LandingRepositorySnapshot): CatalogEntry[] {
  return discoverLandingPages(snapshot).map((page) => ({
    page,
    aliases: [
      page.name.toLowerCase(),
      ...(snapshot.aliases?.[page.source_path] ?? []).map((alias) => alias.toLowerCase()),
    ],
  }));
}

function containsExactUrl(input: string, canonicalUrl: string): boolean {
  const escaped = canonicalUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${escaped}(?=$|[\\s,;.!?])`, "i").test(input);
}

function containsTerm(input: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, "i").test(input);
}

function humanize(value: string): string {
  return value
    .split("-")
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/, "");
}

function normalizePathname(pathname: string): string {
  const withLeadingSlash = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return withLeadingSlash === "/" ? withLeadingSlash : withLeadingSlash.replace(/\/$/, "");
}

/**
 * Locally observed candidate snapshot at 985a83f. It is safe for deterministic
 * discovery, but must not be used for checkout until the canonical remote and
 * clean base are confirmed independently.
 */
export const LOCAL_CANDIDATE_LANDING_SNAPSHOT: LandingRepositorySnapshot = {
  baseDomain: "skydeo.com",
  registeredHostnames: ["pizza-consumer.skydeo.com", "tacograph.skydeo.com"],
  sourcePaths: [
    "src/domains/anotherone/pages/index.astro",
    "src/domains/pizza-consumer/pages/index.astro",
    "src/domains/somegraph/pages/details.astro",
    "src/domains/somegraph/pages/index.astro",
    "src/domains/tacograph/pages/index.astro",
  ],
  pageNames: { tacograph: "TacoGraph" },
};
