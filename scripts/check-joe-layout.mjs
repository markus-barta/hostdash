#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const joeSource = await readFile(resolve(repoRoot, "public/joe/joe.js"), "utf8");
const versionSource = await readFile(resolve(repoRoot, "public/joe/joe-version.js"), "utf8");

function extractJoeBlock(startMarker, endMarker) {
  const start = joeSource.indexOf(startMarker);
  const end = joeSource.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error(`${startMarker} missing from joe.js`);
  return joeSource.slice(start, end);
}

const layoutContext = extractJoeBlock("  var DEFAULT_LAYOUT = [", "\n  var COLORS = ");
const sanitizeLayoutItems = new Function(`${layoutContext}\n${extractJoeBlock("  function sanitizeLayoutItems", "\n\n  function safeStoredLayout")}\nreturn sanitizeLayoutItems;`)();
const defaultLayoutsCatalog = new Function(`${layoutContext}\n  var LAYOUTS_KEY = \"joe-board-named-layouts-v1\";\n  var DEFAULT_LAYOUT_ID = \"default\";\n${extractJoeBlock("  function defaultLayoutsCatalog", "\n\n  function normalizeLayoutEntry")}\nreturn defaultLayoutsCatalog;`)();
const normalizeLayoutEntry = new Function(`${layoutContext}\n  var DEFAULT_LAYOUT_ID = \"default\";\n${extractJoeBlock("  function sanitizeLayoutItems", "\n\n  function safeStoredLayout")}\n${extractJoeBlock("  function normalizeLayoutEntry", "\n\n  function readLayoutsCatalog")}\nreturn normalizeLayoutEntry;`)();

const version = new Function("window", `${versionSource}; return window.JoeVersion;`)({});
if (!version?.APP_VERSION || !Array.isArray(version.VERSION_HISTORY) || version.VERSION_HISTORY.length < 4) {
  throw new Error("JoeVersion invalid");
}

const sample = [
  { id: "hero", x: 0, y: 0, w: 12, h: 2 },
  { id: "desk-j", x: 0, y: 2, w: 4, h: 4 },
  { id: "desk-joe", x: 4, y: 2, w: 4, h: 4 },
  { id: "desk-joel", x: 8, y: 2, w: 4, h: 4 },
  { id: "attribution", x: 0, y: 6, w: 4, h: 3 },
  { id: "history", x: 4, y: 6, w: 8, h: 5 },
  { id: "positions", x: 0, y: 11, w: 12, h: 5 },
];

if (!sanitizeLayoutItems(sample)) throw new Error("valid layout rejected");
if (sanitizeLayoutItems(sample.slice(0, 6))) throw new Error("incomplete layout accepted");
if (sanitizeLayoutItems(sample.map((item) => item.id === "hero" ? { ...item, w: 0 } : item))) throw new Error("invalid width accepted");

const catalog = defaultLayoutsCatalog();
if (catalog.schema !== "inspr.joe.layouts.v1" || catalog.layouts.length !== 1 || catalog.layouts[0].id !== "default") {
  throw new Error(`default catalog invalid: ${JSON.stringify(catalog)}`);
}

const normalized = normalizeLayoutEntry({ id: "qa", name: " QA ", items: sample });
if (!normalized || normalized.name !== "QA") throw new Error("layout entry normalization failed");

console.log(JSON.stringify({ ok: true, appVersion: version.APP_VERSION, historyEntries: version.VERSION_HISTORY.length }, null, 2));
