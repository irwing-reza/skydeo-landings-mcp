#!/usr/bin/env node

import { pathToFileURL } from "node:url";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

async function main() {
  const serializedEdits = process.env.LANDING_EDIT_BATCH;
  if (!serializedEdits) fail("Preview verification edits are unavailable");
  let operations;
  try {
    operations = JSON.parse(serializedEdits);
  } catch {
    fail("Preview verification edits are invalid");
  }
  if (!Array.isArray(operations) || operations.length === 0 || operations.length > 8) {
    fail("Preview verification requires 1 to 8 edits");
  }

  let response;
  try {
    response = await fetch("http://127.0.0.1:4321/", { redirect: "manual" });
  } catch {
    fail("The rendered Astro route could not be requested");
  }
  if (response.status < 200 || response.status >= 300) {
    fail(`The rendered Astro route returned HTTP ${String(response.status)}`);
  }
  const html = await response.text();
  if (html.length === 0 || html.length > 2_000_000) {
    fail("The rendered Astro route returned an invalid response body");
  }
  try {
    verifyRenderedPreview(html, operations);
  } catch (error) {
    fail(error instanceof Error ? error.message : "The rendered Astro route is invalid");
  }
  process.stdout.write("preview_verified\n");
}

export function verifyRenderedPreview(html, operations) {
  for (const operation of operations) {
    switch (operation.operation) {
      case "replace_headline":
      case "update_copy":
        requireRenderedText(html, operation.value, operation.operation);
        break;
      case "update_cta":
        if (operation.label !== undefined) requireRenderedText(html, operation.label, "CTA label");
        if (operation.href !== undefined) requireAttribute(html, "href", operation.href, "CTA link");
        break;
      case "update_seo_metadata":
        if (operation.title !== undefined) requireRenderedText(html, operation.title, "SEO title");
        if (operation.description !== undefined) requireAttribute(html, "content", operation.description, "SEO description");
        break;
      case "replace_image":
        requireAttribute(html, "src", operation.src, "image source");
        if (operation.alt !== undefined) requireAttribute(html, "alt", operation.alt, "image alt text");
        break;
      case "apply_page_change": {
        const section = identifierIndex(html, operation.section);
        const reference = identifierIndex(html, operation.reference);
        const correct = operation.position === "before" ? section < reference : section > reference;
        if (!correct) throw new Error("The rendered section order does not match the requested layout change");
        break;
      }
      default:
        throw new Error("Preview verification received an unsupported edit operation");
    }
  }
}

function requireRenderedText(html, value, label) {
  if (!html.includes(value) && !html.includes(escapeHtml(value))) {
    throw new Error(`The rendered Astro route does not contain the expected ${label}`);
  }
}

function requireAttribute(html, attribute, value, label) {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const encoded = escapeHtml(value).replaceAll('"', "&quot;");
  const encodedEscaped = encoded.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(String.raw`\b${attribute}\s*=\s*["'](?:${escaped}|${encodedEscaped})["']`, "iu");
  if (!pattern.test(html)) throw new Error(`The rendered Astro route does not contain the expected ${label}`);
}

function identifierIndex(html, identifier) {
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(String.raw`\b(?:id|data-section)\s*=\s*(["'])${escaped}\1`, "iu").exec(html);
  if (match?.index === undefined) throw new Error(`The rendered Astro route does not contain section ${identifier}`);
  return match.index;
}

function escapeHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(65);
}
