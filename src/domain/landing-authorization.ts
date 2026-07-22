import type { LandingIntent } from "./landing-workflow";

export const LANDING_PERMISSIONS = [
  "landings:read",
  "landings:write",
  "landings:publish",
] as const;

export type LandingPermission = (typeof LANDING_PERMISSIONS)[number];

export function permissionForLandingIntent(intent: LandingIntent): LandingPermission {
  switch (intent) {
    case "inspect_status":
      return "landings:read";
    case "request_publish":
      return "landings:publish";
    default:
      return "landings:write";
  }
}
