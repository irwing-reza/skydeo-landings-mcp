#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { replaceHeadlineSource } from "./apply-landing-headline.mjs";

const workspace = "/workspace/repository";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

async function main() {
  const pagePath = requiredEnvironment("REPOSITORY_PAGE_PATH");
  const serializedEdits = requiredEnvironment("LANDING_EDIT_BATCH");
  if (
    !pagePath.startsWith("src/domains/") ||
    pagePath.startsWith("/") ||
    pagePath.includes("..") ||
    !/^[A-Za-z0-9._/-]+$/.test(pagePath) ||
    !pagePath.includes("/pages/") ||
    !pagePath.endsWith(".astro")
  ) {
    fail("The requested page path is outside the landing Astro source boundary");
  }
  let operations;
  try {
    operations = JSON.parse(serializedEdits);
  } catch {
    fail("The structured landing edit batch is invalid");
  }
  assertEditBatch(operations);

  const absolutePath = resolve(workspace, pagePath);
  if (!absolutePath.startsWith(`${workspace}/`)) {
    fail("The requested page path is outside the repository workspace");
  }
  const source = await readFile(absolutePath, "utf8");
  let updated;
  try {
    updated = applyLandingEdits(source, operations);
  } catch (error) {
    fail(error instanceof Error ? error.message : "The bounded Astro edit was rejected");
  }
  await writeFile(absolutePath, updated, "utf8");
  process.stdout.write("landing_edits_applied\n");
}

export function applyLandingEdits(source, operations) {
  let updated = source;
  for (const operation of operations) {
    switch (operation.operation) {
      case "replace_headline":
        updated = replaceHeadlineSource(updated, operation.value);
        break;
      case "update_copy":
        updated = updateHeroElementText(updated, "p", "body-copy", operation.value);
        break;
      case "update_cta":
        updated = updateHeroCta(updated, operation);
        break;
      case "update_seo_metadata":
        updated = updateSeoMetadata(updated, operation);
        break;
      case "replace_image":
        updated = updateHeroImage(updated, operation);
        break;
      case "apply_page_change":
        updated = moveSection(updated, operation);
        break;
      default:
        throw new Error("The edit batch contains an unsupported operation");
    }
  }
  if (updated === source) {
    throw new Error("The requested edit batch did not create a new source revision");
  }
  return updated;
}

function updateHeroElementText(source, tag, role, value) {
  const scope = heroScope(source);
  const candidates = elementMatches(source, tag, scope);
  const preferred = candidates.filter(({ opening }) => hasLandingRole(opening, role));
  const selected = uniquePreferred(preferred, candidates, `hero ${role}`);
  return replaceElementText(source, selected, value);
}

function updateHeroCta(source, operation) {
  const scope = heroScope(source);
  const candidates = elementMatches(source, "a", scope);
  const preferred = candidates.filter(({ opening }) => hasLandingRole(opening, "cta"));
  const selected = uniquePreferred(preferred, candidates, "hero CTA");
  let replacement = selected.full;
  if (operation.label !== undefined) {
    replacement = replaceElementText(replacement, elementMatches(replacement, "a", { start: 0, end: replacement.length })[0], operation.label);
  }
  if (operation.href !== undefined) {
    replacement = replaceStaticAttribute(replacement, "href", operation.href, "CTA");
  }
  if (replacement === selected.full) throw new Error("The requested CTA values are already present");
  return source.slice(0, selected.start) + replacement + source.slice(selected.end);
}

function updateHeroImage(source, operation) {
  const scope = heroScope(source);
  const candidates = voidElementMatches(source, "img", scope);
  const preferred = candidates.filter(({ full }) => hasLandingRole(full, "image"));
  const selected = uniquePreferred(preferred, candidates, "hero image");
  let replacement = replaceStaticAttribute(selected.full, "src", operation.src, "image");
  if (operation.alt !== undefined) {
    replacement = replaceOrAddStaticAttribute(replacement, "alt", operation.alt);
  }
  if (replacement === selected.full) throw new Error("The requested image values are already present");
  return source.slice(0, selected.start) + replacement + source.slice(selected.end);
}

function updateSeoMetadata(source, operation) {
  let updated = source;
  if (operation.title !== undefined) {
    const titles = elementMatches(updated, "title", { start: 0, end: updated.length });
    if (titles.length === 1) {
      updated = replaceElementText(updated, titles[0], operation.title);
    } else {
      updated = replaceSeoComponentAttribute(updated, "title", operation.title);
    }
  }
  if (operation.description !== undefined) {
    const metadata = [...updated.matchAll(/<meta\b[^>]*\bname\s*=\s*(["'])description\1[^>]*>/giu)];
    if (metadata.length === 1 && metadata[0]?.index !== undefined) {
      const full = metadata[0][0];
      const replacement = replaceStaticAttribute(full, "content", operation.description, "SEO description");
      updated = updated.slice(0, metadata[0].index) + replacement + updated.slice(metadata[0].index + full.length);
    } else {
      updated = replaceSeoComponentAttribute(updated, "description", operation.description);
    }
  }
  return updated;
}

function replaceSeoComponentAttribute(source, attribute, value) {
  const candidates = [...source.matchAll(/<[A-Z][A-Za-z0-9_.:-]*\b[^>]*>/gu)].filter((match) =>
    new RegExp(String.raw`\b${attribute}\s*=\s*["']`, "u").test(match[0]),
  );
  if (candidates.length !== 1 || candidates[0]?.index === undefined) {
    throw new Error(`Expected one static SEO ${attribute} target in the Astro page`);
  }
  const full = candidates[0][0];
  const replacement = replaceStaticAttribute(full, attribute, value, `SEO ${attribute}`);
  return source.slice(0, candidates[0].index) + replacement + source.slice(candidates[0].index + full.length);
}

function moveSection(source, operation) {
  const sections = pairedElementSpans(source, "section");
  const moving = uniqueSection(sections, operation.section);
  const reference = uniqueSection(sections, operation.reference);
  if (rangesOverlap(moving, reference)) {
    throw new Error("Nested sections cannot be reordered by the bounded layout operation");
  }
  const block = source.slice(moving.start, moving.end);
  const without = source.slice(0, moving.start) + source.slice(moving.end);
  const adjustedReference = moving.start < reference.start
    ? { ...reference, start: reference.start - block.length, end: reference.end - block.length }
    : reference;
  const insertion = operation.position === "before" ? adjustedReference.start : adjustedReference.end;
  const updated = without.slice(0, insertion) + block + without.slice(insertion);
  if (updated === source) throw new Error("The requested section order is already present");
  return updated;
}

function heroScope(source) {
  const heading = [...source.matchAll(/<h1\b[^>]*>[\s\S]*?<\/h1>/giu)];
  if (heading.length !== 1 || heading[0]?.index === undefined) {
    throw new Error("Expected exactly one h1 before locating the hero edit targets");
  }
  const headingStart = heading[0].index;
  const headingEnd = headingStart + heading[0][0].length;
  const containers = [...pairedElementSpans(source, "section"), ...pairedElementSpans(source, "main")]
    .filter(({ start, end }) => start <= headingStart && end >= headingEnd)
    .sort((left, right) => (left.end - left.start) - (right.end - right.start));
  return containers[0] ?? { start: 0, end: source.length };
}

function pairedElementSpans(source, tag) {
  const tokens = [...source.matchAll(new RegExp(`<\\/?${tag}\\b[^>]*>`, "giu"))];
  const stack = [];
  const spans = [];
  for (const token of tokens) {
    if (token.index === undefined) continue;
    if (token[0].startsWith("</")) {
      const opening = stack.pop();
      if (opening === undefined) throw new Error(`Unbalanced ${tag} markup cannot be edited safely`);
      spans.push({ start: opening, end: token.index + token[0].length, opening: source.slice(opening, source.indexOf(">", opening) + 1) });
    } else {
      stack.push(token.index);
    }
  }
  if (stack.length !== 0) throw new Error(`Unbalanced ${tag} markup cannot be edited safely`);
  return spans;
}

function elementMatches(source, tag, scope) {
  const pattern = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}>`, "giu");
  return [...source.matchAll(pattern)]
    .filter((match) => match.index !== undefined && match.index >= scope.start && match.index + match[0].length <= scope.end)
    .map((match) => ({
      full: match[0],
      inner: match[2] ?? "",
      opening: `<${tag}${match[1] ?? ""}>`,
      start: match.index,
      end: match.index + match[0].length,
    }));
}

function voidElementMatches(source, tag, scope) {
  return [...source.matchAll(new RegExp(`<${tag}\\b[^>]*\\/?\\s*>`, "giu"))]
    .filter((match) => match.index !== undefined && match.index >= scope.start && match.index + match[0].length <= scope.end)
    .map((match) => ({ full: match[0], start: match.index, end: match.index + match[0].length }));
}

function replaceElementText(source, element, value) {
  if (element === undefined) throw new Error("The expected static text target is unavailable");
  const segments = [...element.inner.matchAll(/(^|>)([^<]+)(?=<|$)/gu)].filter((match) => (match[2] ?? "").trim().length > 0);
  if (segments.length !== 1 || segments[0]?.index === undefined || /[{}]|<!--|-->/u.test(element.inner)) {
    throw new Error("The selected text target has dynamic or multiple text regions");
  }
  const segment = segments[0];
  const original = segment[2] ?? "";
  const leading = original.match(/^\s*/u)?.[0] ?? "";
  const trailing = original.match(/\s*$/u)?.[0] ?? "";
  const start = element.opening.length + segment.index + (segment[1]?.length ?? 0);
  const replacement = element.full.slice(0, start) + leading + escapeHtml(value) + trailing + element.full.slice(start + original.length);
  if (replacement === element.full) throw new Error("The requested text is already present");
  return source.slice(0, element.start) + replacement + source.slice(element.end);
}

function replaceStaticAttribute(opening, attribute, value, label) {
  const pattern = new RegExp(String.raw`\b${attribute}\s*=\s*(["'])(.*?)\1`, "iu");
  const matches = [...opening.matchAll(new RegExp(pattern.source, "giu"))];
  if (matches.length !== 1 || matches[0]?.index === undefined) {
    throw new Error(`Expected one static ${label} ${attribute} attribute`);
  }
  const match = matches[0];
  const quote = match[1] ?? '"';
  const escaped = escapeAttribute(value, quote);
  return opening.slice(0, match.index) + `${attribute}=${quote}${escaped}${quote}` + opening.slice(match.index + match[0].length);
}

function replaceOrAddStaticAttribute(opening, attribute, value) {
  if (new RegExp(String.raw`\b${attribute}\s*=`, "iu").test(opening)) {
    return replaceStaticAttribute(opening, attribute, value, "image");
  }
  const closing = opening.endsWith("/>") ? "/>" : ">";
  return `${opening.slice(0, -closing.length)} ${attribute}="${escapeAttribute(value, '"')}"${closing}`;
}

function uniquePreferred(preferred, fallback, label) {
  const candidates = preferred.length > 0 ? preferred : fallback;
  if (candidates.length !== 1 || candidates[0] === undefined) {
    throw new Error(`Expected exactly one ${label} in the h1 container`);
  }
  return candidates[0];
}

function uniqueSection(sections, identifier) {
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(String.raw`\b(?:id|data-section)\s*=\s*(["'])${escaped}\1`, "u");
  const matches = sections.filter(({ opening }) => pattern.test(opening));
  if (matches.length !== 1 || matches[0] === undefined) {
    throw new Error(`Expected exactly one section identified as ${identifier}`);
  }
  return matches[0];
}

function hasLandingRole(opening, role) {
  const escaped = role.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(String.raw`\bdata-landing-role\s*=\s*(["'])${escaped}\1`, "iu").test(opening);
}

function rangesOverlap(left, right) {
  return left.start < right.end && right.start < left.end;
}

function escapeHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeAttribute(value, quote) {
  const escaped = escapeHtml(value);
  return quote === '"' ? escaped.replaceAll('"', "&quot;") : escaped.replaceAll("'", "&#39;");
}

function assertEditBatch(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) {
    fail("The structured landing edit batch must contain 1 to 8 operations");
  }
  const allowed = new Set(["replace_headline", "update_copy", "update_cta", "update_seo_metadata", "replace_image", "apply_page_change"]);
  for (const operation of value) {
    if (!operation || typeof operation !== "object" || !allowed.has(operation.operation)) {
      fail("The structured landing edit batch contains an unsupported operation");
    }
  }
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) fail(`Required edit input ${name} is unavailable`);
  return value;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(64);
}
