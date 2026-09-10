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
const layoutHelpers = `${layoutContext}
  var LAYOUTS_KEY = "joe-board-named-layouts-v1";
  var DEFAULT_LAYOUT_ID = "default";
  var MAX_LAYOUTS = 24;
${extractJoeBlock("  function layoutCoordinate", "\n\n  function safeStoredLayout")}
${extractJoeBlock("  function defaultLayoutEntry", "\n\n  function bindLayoutControls")}`;

const api = new Function(`${layoutHelpers}
  return {
    sanitizeLayoutItems,
    defaultLayoutEntry,
    defaultLayoutsCatalog,
    normalizeLayoutEntry,
    canonicalLayoutsCatalog,
    writeLayoutsCatalog: function(catalog) {
      if (!catalog || catalog.schema !== "inspr.joe.layouts.v1" || !Array.isArray(catalog.layouts)) return false;
      if (catalog.layouts.length > MAX_LAYOUTS) return false;
      return canonicalLayoutsCatalog(catalog.layouts).layouts.length;
    }
  };
`)();

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

if (!api.sanitizeLayoutItems(sample)) throw new Error("valid layout rejected");
if (api.sanitizeLayoutItems(sample.slice(0, 6))) throw new Error("incomplete layout accepted");
if (api.sanitizeLayoutItems(sample.map((item) => item.id === "hero" ? { ...item, w: 0 } : item))) throw new Error("invalid width accepted");
if (api.sanitizeLayoutItems(sample.concat({ id: "hero", x: 0, y: 0, w: 12, h: 2 }))) throw new Error("duplicate id accepted");
if (api.sanitizeLayoutItems(sample.map((item) => item.id === "hero" ? { ...item, x: 1.5 } : item))) throw new Error("fractional coordinate accepted");
if (api.sanitizeLayoutItems(sample.map((item) => item.id === "hero" ? { ...item, x: 11, w: 2 } : item))) throw new Error("overflow width accepted");

const alteredDefault = api.normalizeLayoutEntry({ id: "default", name: "Default", items: sample.map((item) => item.id === "hero" ? { ...item, h: 9 } : item) });
if (!alteredDefault || alteredDefault.items.find((item) => item.id === "hero").h !== 2) {
  throw new Error("default layout must stay canonical");
}

const catalog = api.defaultLayoutsCatalog();
if (catalog.layouts.length !== 1 || catalog.layouts[0].id !== "default") throw new Error("default catalog invalid");

const canonical = api.canonicalLayoutsCatalog([
  { id: "default", name: "Default", items: sample.map((item) => item.id === "hero" ? { ...item, h: 9 } : item) },
  { id: "qa", name: "QA", items: sample },
  { id: "qa", name: "Dup", items: sample },
]);
if (canonical.layouts.length !== 2) throw new Error("duplicate layout ids not deduped");
if (canonical.layouts[0].items.find((item) => item.id === "hero").h !== 2) throw new Error("canonical default not restored");

const tooMany = { schema: "inspr.joe.layouts.v1", layouts: Array.from({ length: 25 }, (_, index) => ({ id: `layout-${index}`, name: `Layout ${index}`, items: sample })) };
if (api.writeLayoutsCatalog(tooMany)) throw new Error("catalog over limit accepted");

console.log(JSON.stringify({ ok: true, appVersion: version.APP_VERSION, checks: 11 }, null, 2));
