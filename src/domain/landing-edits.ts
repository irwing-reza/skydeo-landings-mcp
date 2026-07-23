export type LandingEditOperation =
  | { operation: "replace_headline"; value: string }
  | { operation: "update_copy"; value: string }
  | { operation: "update_cta"; label?: string; href?: string }
  | { operation: "update_seo_metadata"; title?: string; description?: string }
  | { operation: "replace_image"; src: string; alt?: string }
  | {
      operation: "apply_page_change";
      action: "move_section";
      section: string;
      position: "before" | "after";
      reference: string;
    };

export type LandingEditParseResult =
  | { status: "parsed"; operations: readonly LandingEditOperation[] }
  | { status: "needs_details"; message: string };

const QUOTED = String.raw`(?:"([^"]+)"|'([^']+)'|“([^”]+)”)`;
const MAX_OPERATIONS = 8;

/** Parse a deliberately small natural-language edit grammar into one atomic batch. */
export function parseLandingEditBatch(request: string): LandingEditParseResult {
  const operations: LandingEditOperation[] = [];
  const headline = singleValue(request, new RegExp(String.raw`\b(?:headline|heading)\s+(?:to|with)\s+${QUOTED}`, "giu"));
  const copy = singleValue(request, new RegExp(String.raw`\b(?:body|hero)\s+copy\s+(?:to|with)\s+${QUOTED}`, "giu"));
  const ctaLabel = singleValue(request, new RegExp(String.raw`\bcta\s+(?:text|label)\s+(?:to|with)\s+${QUOTED}`, "giu"));
  const ctaHref = singleValue(request, new RegExp(String.raw`\bcta\s+(?:url|link|href)\s+(?:to|with)\s+${QUOTED}`, "giu"));
  const seoTitle = singleValue(request, new RegExp(String.raw`\bseo\s+title\s+(?:to|with)\s+${QUOTED}`, "giu"));
  const seoDescription = singleValue(request, new RegExp(String.raw`\bseo\s+description\s+(?:to|with)\s+${QUOTED}`, "giu"));
  const imageSrc = singleValue(request, new RegExp(String.raw`\bimage\s+(?:src|source|url)\s+(?:to|with)\s+${QUOTED}`, "giu"));
  const imageAlt = singleValue(request, new RegExp(String.raw`\bimage\s+alt(?:\s+text)?\s+(?:to|with)\s+${QUOTED}`, "giu"));
  const sectionMove = singleSectionMove(request);

  const duplicate = [headline, copy, ctaLabel, ctaHref, seoTitle, seoDescription, imageSrc, imageAlt]
    .find((value) => value.status === "duplicate");
  if (duplicate !== undefined || sectionMove.status === "duplicate") {
    return {
      status: "needs_details",
      message: "Specify each edit field at most once in a request.",
    };
  }

  if (headline.status === "value") {
    operations.push({ operation: "replace_headline", value: headline.value });
  }
  if (copy.status === "value") {
    operations.push({ operation: "update_copy", value: copy.value });
  }
  if (ctaLabel.status === "value" || ctaHref.status === "value") {
    operations.push({
      operation: "update_cta",
      ...(ctaLabel.status === "value" ? { label: ctaLabel.value } : {}),
      ...(ctaHref.status === "value" ? { href: ctaHref.value } : {}),
    });
  }
  if (seoTitle.status === "value" || seoDescription.status === "value") {
    operations.push({
      operation: "update_seo_metadata",
      ...(seoTitle.status === "value" ? { title: seoTitle.value } : {}),
      ...(seoDescription.status === "value" ? { description: seoDescription.value } : {}),
    });
  }
  if (imageSrc.status === "value") {
    operations.push({
      operation: "replace_image",
      src: imageSrc.value,
      ...(imageAlt.status === "value" ? { alt: imageAlt.value } : {}),
    });
  } else if (imageAlt.status === "value") {
    return {
      status: "needs_details",
      message: "An image update requires an explicit image source as well as optional alt text.",
    };
  }
  if (sectionMove.status === "value") {
    operations.push(sectionMove.value);
  }

  if (operations.length === 0) {
    const legacyHeadline = /\b(?:headline|heading)\s+(?:to|with)\s+([^;\r\n]+)$/iu.exec(request.trim())?.[1]?.trim();
    if (legacyHeadline !== undefined && validText(legacyHeadline, 160)) {
      operations.push({ operation: "replace_headline", value: stripPairedQuotes(legacyHeadline) });
    }
  }

  const validationFailure = validateOperations(operations);
  if (validationFailure !== null) {
    return { status: "needs_details", message: validationFailure };
  }
  if (operations.length === 0) {
    return {
      status: "needs_details",
      message:
        "Use quoted values for body copy, CTA, SEO, and image changes. Section moves must name both section identifiers.",
    };
  }
  if (operations.length > MAX_OPERATIONS) {
    return {
      status: "needs_details",
      message: `Limit one edit batch to ${String(MAX_OPERATIONS)} operations.`,
    };
  }
  return { status: "parsed", operations };
}

export function summarizeLandingEdits(
  hostname: string,
  operations: readonly LandingEditOperation[],
): string {
  const labels = operations.map((operation) => {
    switch (operation.operation) {
      case "replace_headline": return "headline";
      case "update_copy": return "hero body copy";
      case "update_cta": return "CTA";
      case "update_seo_metadata": return "SEO metadata";
      case "replace_image": return "hero image";
      case "apply_page_change": return `section order (${operation.section} ${operation.position} ${operation.reference})`;
    }
  });
  return `Updated ${formatList(labels)} on ${hostname}.`;
}

export function landingEditOperationNames(
  operations: readonly LandingEditOperation[],
): readonly LandingEditOperation["operation"][] {
  return operations.map(({ operation }) => operation);
}

type ValueMatch = { status: "absent" } | { status: "duplicate" } | { status: "value"; value: string };

function singleValue(request: string, pattern: RegExp): ValueMatch {
  const matches = [...request.matchAll(pattern)];
  if (matches.length === 0) return { status: "absent" };
  if (matches.length > 1) return { status: "duplicate" };
  const match = matches[0];
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value === undefined ? { status: "absent" } : { status: "value", value: value.trim() };
}

function singleSectionMove(request: string):
  | { status: "absent" | "duplicate" }
  | { status: "value"; value: Extract<LandingEditOperation, { operation: "apply_page_change" }> } {
  const pattern = new RegExp(
    String.raw`\bmove\s+section\s+${QUOTED}\s+(before|after)\s+section\s+${QUOTED}`,
    "giu",
  );
  const matches = [...request.matchAll(pattern)];
  if (matches.length === 0) return { status: "absent" };
  if (matches.length > 1) return { status: "duplicate" };
  const match = matches[0];
  const section = match?.[1] ?? match?.[2] ?? match?.[3];
  const position = match?.[4];
  const reference = match?.[5] ?? match?.[6] ?? match?.[7];
  if (section === undefined || reference === undefined || (position !== "before" && position !== "after")) {
    return { status: "absent" };
  }
  return {
    status: "value",
    value: { operation: "apply_page_change", action: "move_section", section, position, reference },
  };
}

function validateOperations(operations: readonly LandingEditOperation[]): string | null {
  for (const operation of operations) {
    switch (operation.operation) {
      case "replace_headline":
        if (!validText(operation.value, 160)) return "The headline must contain 1 to 160 characters.";
        break;
      case "update_copy":
        if (!validText(operation.value, 600)) return "Hero body copy must contain 1 to 600 characters.";
        break;
      case "update_cta":
        if (operation.label !== undefined && !validText(operation.label, 80)) return "CTA text must contain 1 to 80 characters.";
        if (operation.href !== undefined && !validLink(operation.href)) return "CTA links must be HTTPS, root-relative, hash, or mailto URLs.";
        break;
      case "update_seo_metadata":
        if (operation.title !== undefined && !validText(operation.title, 70)) return "SEO titles must contain 1 to 70 characters.";
        if (operation.description !== undefined && !validText(operation.description, 180)) return "SEO descriptions must contain 1 to 180 characters.";
        break;
      case "replace_image":
        if (!validImageSource(operation.src)) return "Image sources must be HTTPS or repository-root-relative URLs.";
        if (operation.alt !== undefined && !validText(operation.alt, 180)) return "Image alt text must contain 1 to 180 characters.";
        break;
      case "apply_page_change":
        if (!validIdentifier(operation.section) || !validIdentifier(operation.reference) || operation.section === operation.reference) {
          return "Section moves require two different simple section identifiers.";
        }
        break;
    }
  }
  return null;
}

function validText(value: string, maximum: number): boolean {
  return value.trim() === value && value.length > 0 && value.length <= maximum && !/[\r\n]/u.test(value);
}

function validLink(value: string): boolean {
  return /^(?:https:\/\/|\/|#|mailto:)[^\s]+$/iu.test(value) && !value.includes("\0");
}

function validImageSource(value: string): boolean {
  return /^(?:https:\/\/|\/)[^\s]+$/iu.test(value) && !value.includes("\0");
}

function validIdentifier(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,80}$/u.test(value);
}

function stripPairedQuotes(value: string): string {
  const match = /^(?:"([\s\S]*)"|'([\s\S]*)'|“([\s\S]*)”)$/u.exec(value);
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? value).trim();
}

function formatList(values: readonly string[]): string {
  if (values.length <= 1) return values[0] ?? "landing page";
  return `${values.slice(0, -1).join(", ")} and ${values.at(-1) ?? "landing page"}`;
}
