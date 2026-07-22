export const LANDING_SCOPES = [
  "landings:read",
  "landings:write",
  "landings:publish",
] as const;

export type LandingScope = (typeof LANDING_SCOPES)[number];

export function isLandingScope(value: string): value is LandingScope {
  return LANDING_SCOPES.some((scope) => scope === value);
}
