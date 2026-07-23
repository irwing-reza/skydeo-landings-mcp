#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const workspace = "/workspace/repository";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

async function main() {
  const pagePath = requiredEnvironment("REPOSITORY_PAGE_PATH");
  const headline = requiredEnvironment("LANDING_HEADLINE");

  if (
    !pagePath.startsWith("src/domains/") ||
    pagePath.startsWith("/") ||
    pagePath.includes("..") ||
    !/^[A-Za-z0-9._/-]+$/.test(pagePath) ||
    !pagePath.includes("/pages/") ||
    !pagePath.endsWith(".astro")
  ) {
    fail("The requested page path is outside the landing source boundary");
  }
  if (headline.trim() !== headline || headline.length > 160 || /[\r\n]/.test(headline)) {
    fail("The replacement headline must be one line containing 1 to 160 characters");
  }

  const absolutePath = resolve(workspace, pagePath);
  if (!absolutePath.startsWith(`${workspace}/`)) {
    fail("The requested page path is outside the repository workspace");
  }

  const source = await readFile(absolutePath, "utf8");
  const updatedSource = replaceHeadlineSource(source, headline);
  await writeFile(absolutePath, updatedSource, "utf8");
  process.stdout.write("headline_replaced\n");
}

export function replaceHeadlineSource(source, headline) {
  const headings = [...source.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)];
  if (headings.length !== 1 || headings[0]?.index === undefined) {
    throw new Error("Expected exactly one h1 in the resolved Astro page; no change was applied");
  }

  const match = headings[0];
  const heading = match[0];
  const inner = match[1] ?? "";
  if (/[{}]|<!--|-->/u.test(inner)) {
    throw new Error("The h1 uses dynamic or ambiguous Astro markup; no change was applied");
  }

  const textSegments = [...inner.matchAll(/(^|>)([^<]+)(?=<|$)/g)].filter(
    (segment) => (segment[2] ?? "").trim().length > 0,
  );
  if (textSegments.length !== 1 || textSegments[0]?.index === undefined) {
    throw new Error("The h1 has multiple text regions; identify a narrower source change");
  }

  const segment = textSegments[0];
  const originalText = segment[2] ?? "";
  const leading = originalText.match(/^\s*/u)?.[0] ?? "";
  const trailing = originalText.match(/\s*$/u)?.[0] ?? "";
  const escapedHeadline = headline
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  const innerStart = heading.indexOf(">") + 1;
  const segmentStart = innerStart + segment.index + (segment[1]?.length ?? 0);
  const updatedHeading =
    heading.slice(0, segmentStart) +
    leading +
    escapedHeadline +
    trailing +
    heading.slice(segmentStart + originalText.length);
  const updatedSource =
    source.slice(0, match.index) +
    updatedHeading +
    source.slice(match.index + heading.length);

  if (updatedSource === source) {
    throw new Error("The requested headline is already present; no new revision was created");
  }
  return updatedSource;
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) {
    fail(`Required edit input ${name} is unavailable`);
  }
  return value;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(64);
}
