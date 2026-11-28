#!/usr/bin/env node
// URL compatibility sweep (HOSTD-83 gate r3): every service's link and probe target,
// resolved by origin/main's page and by this branch's page, on an http and an https
// dashboard origin, and every difference listed.
//
// Inputs, never copies:
//   - origin/main's public/index.html (`git show <base>:public/index.html`): its
//     serviceTargetUrl(), cleanServices() and helpers are cut out of the file and run in
//     a VM with a fake window.location. Its link/probe decision (index.html around
//     `card.href = targetUrl`) is a few lines inside a render loop, so it is restated
//     below and pinned: the sweep fails if those exact lines are no longer in the base.
//   - this branch's public/index.html: the whole `<evidence-core>` block plus its
//     cleanServices(), run the same way.
//   - every hosts/*/config.js, and the manifests smoke-ui.mjs serves (its own
//     manifestFromConfig(), cut out of the script) for the boards it runs in manifest
//     mode (hsb1, hsb8).
//   - for every same-host service, the scheme spellings origin/main's URL setter
//     accepted ("https", "HTTPS:", "https:", "https://", "HTTP", "http:"), so the class of the r3
//     finding is swept, not only the spellings the configs happen to use today.
//
// Every difference must be classified as intended (a reason below), or the sweep fails.
//
//   node scripts/url-sweep.mjs                      # base origin/main, new = working tree
//   node scripts/url-sweep.mjs --base <ref> --new <ref|path>
//   node scripts/url-sweep.mjs --json
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import vm from "node:vm";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
const baseRef = opt("--base", "origin/main");
const newRef = opt("--new", null);
const asJson = args.includes("--json");

const gitShow = (ref, path) => execFileSync("git", ["show", `${ref}:${path}`], { cwd: repoRoot, encoding: "utf8", maxBuffer: 1 << 26 });
const readNew = path => newRef
  ? (existsSync(newRef) ? readFileSync(newRef, "utf8") : gitShow(newRef, path))
  : readFileSync(join(repoRoot, path), "utf8");

// ── cutting definitions out of a source file ────────────────────────────────
// A top-level `function NAME(…) { … }` (brace-matched, strings skipped) or a
// `const NAME = …;` (up to the first `;` at bracket depth 0).
function cut(source, name) {
  const fn = new RegExp(`^(async )?function ${name}\\(`, "m").exec(source);
  const konst = new RegExp(`^const ${name} = `, "m").exec(source);
  const start = fn ? fn.index : konst ? konst.index : -1;
  if (start < 0) throw new Error(`definition of ${name} not found`);
  let depth = 0;
  let quote = null;
  let seenBrace = false;
  for (let i = start; i < source.length; i += 1) {
    const c = source[i];
    if (quote) {
      if (c === "\\") i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    // Line comments ("dashboard's") are not strings.
    if (c === "/" && source[i + 1] === "/") { i = source.indexOf("\n", i); if (i < 0) break; continue; }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === "{" || c === "(" || c === "[") { depth += 1; if (c === "{") seenBrace = true; continue; }
    if (c === "}" || c === ")" || c === "]") {
      depth -= 1;
      if (fn && depth === 0 && c === "}" && seenBrace) return source.slice(start, i + 1);
      continue;
    }
    if (!fn && depth === 0 && c === ";") return source.slice(start, i + 1);
  }
  throw new Error(`end of ${name} not found`);
}

const CLEAN_HELPERS = ["isObject", "objectOr", "arrayOrEmpty", "stringOr", "isLocalizable", "localizedOr", "cleanServices"];

// origin/main: its own functions, its own decision lines.
const baseHtml = gitShow(baseRef, "public/index.html");
const BASE_DECISION = [
  "const active = !service.passive;",
  "const targetUrl = serviceTargetUrl(service);",
  "card.href = targetUrl;",
  "if (service.status) card.dataset.staticState = service.status;",
  'else if (service.probe === false) card.dataset.staticState = "external";',
  "else card.dataset.probe = targetUrl;",
];
const missing = BASE_DECISION.filter(line => !baseHtml.includes(line));
if (missing.length) throw new Error(`origin/main's link/probe decision changed; restate it here first: ${JSON.stringify(missing)}`);
const baseSandbox = { window: { location: null }, URL };
vm.runInNewContext([...CLEAN_HELPERS.map(name => cut(baseHtml, name)), cut(baseHtml, "serviceTargetUrl"),
  "this.cleanServices = cleanServices; this.serviceTargetUrl = serviceTargetUrl;"].join("\n"), baseSandbox);
// What an <a href> / fetch() does with whatever the page assigned: resolve it on the page.
const asBrowser = (value, pageHref) => {
  try { return new URL(String(value), pageHref).href; } catch { return String(value); }
};
function baseResolve(service, pageHref) {
  baseSandbox.window.location = new URL(pageHref);
  if (service.passive) return { link: null, probe: null };
  const targetUrl = baseSandbox.serviceTargetUrl(service);
  const href = asBrowser(targetUrl, pageHref);
  return { link: href, probe: service.status || service.probe === false ? null : href };
}

// This branch: the evidence core as shipped.
const newHtml = readNew("public/index.html");
const block = newHtml.match(/\/\/ <evidence-core>\n([\s\S]*?)\/\/ <\/evidence-core>/);
if (!block) throw new Error("evidence-core markers not found in the new page");
const newSandbox = { URL };
vm.runInNewContext([...CLEAN_HELPERS.map(name => cut(newHtml, name)), block[1],
  "this.cleanServices = cleanServices; this.core = EvidenceCore;"].join("\n"), newSandbox);
function newResolve(service, pageHref) {
  const url = newSandbox.core.resolveTarget(service, pageHref);
  const model = newSandbox.core.serviceModel(service, url);
  return { link: service.passive !== true && url ? url : null, probe: model.probeUrl };
}

// ── the services ────────────────────────────────────────────────────────────
const configOf = host => {
  const sandbox = { window: {} };
  vm.runInNewContext(readFileSync(join(repoRoot, "hosts", host, "config.js"), "utf8"), sandbox);
  return sandbox.window.HOSTDASH_CONFIG;
};
const smoke = readFileSync(join(repoRoot, "scripts", "smoke-ui.mjs"), "utf8");
const manifestSandbox = {};
vm.runInNewContext(`${cut(smoke, "manifestFromConfig")}\nthis.manifestFromConfig = manifestFromConfig;`, manifestSandbox);
const MANIFEST_BOARDS = new Set(["hsb1", "hsb8"]); // the smoke matrix's manifest runs

const hosts = readdirSync(join(repoRoot, "hosts")).filter(name => existsSync(join(repoRoot, "hosts", name, "config.js"))).sort();
const english = value => typeof value === "string" ? value : value?.en || JSON.stringify(value);
const cases = [];
for (const host of hosts) {
  const config = configOf(host);
  for (const service of config.services) cases.push({ host, source: "config.js", service, base: service, next: service });
  if (MANIFEST_BOARDS.has(host)) {
    // A manifest goes through each page's own cleanServices(), as it would in the browser.
    const raw = JSON.parse(JSON.stringify(manifestSandbox.manifestFromConfig(config).services));
    const base = baseSandbox.cleanServices(JSON.parse(JSON.stringify(raw)));
    const next = newSandbox.cleanServices(JSON.parse(JSON.stringify(raw)));
    raw.forEach((service, i) => cases.push({ host, source: "manifest (smoke fixture)", service, base: base[i], next: next[i] }));
  }
  for (const service of config.services.filter(item => item.sameHost === true && item.passive !== true)) {
    for (const scheme of ["https", "HTTPS:", "https:", "https://", "HTTP", "http:"]) {
      const variant = { ...service, scheme };
      cases.push({ host, source: `config.js, scheme ${JSON.stringify(scheme)}`, service: variant, base: variant, next: variant });
    }
  }
}

// ── intended differences ────────────────────────────────────────────────────
const INTENDED = [
  {
    id: "no-target",
    reason: "an active service with neither a web url nor same-host fields: origin/main assigned `undefined` and linked/probed the page-relative path /undefined; now it gets no link and no probe (round-2 sweep)",
    test: d => d.main !== null && /\/undefined$/.test(d.main) && d.next === null,
  },
  {
    id: "non-web",
    reason: "a url that is not http(s) (javascript:, data:, file:): origin/main linked and probed it; now neither (round-2 sweep)",
    test: d => d.main !== null && !/^https?:/.test(d.main) && d.next === null,
  },
];

const diffs = [];
let compared = 0;
for (const item of cases) {
  for (const origin of ["http", "https"]) {
    const pageHref = `${origin}://${item.host}.lan/index.html`;
    const main = baseResolve(item.base, pageHref);
    const next = newResolve(item.next, pageHref);
    for (const field of ["link", "probe"]) {
      compared += 1;
      if (main[field] === next[field]) continue;
      const diff = { host: item.host, source: item.source, service: english(item.service.name), origin, field, main: main[field], next: next[field] };
      const intended = INTENDED.find(rule => rule.test(diff));
      diffs.push({ ...diff, intended: intended?.id || null });
    }
  }
}
const unexpected = diffs.filter(diff => !diff.intended);

if (asJson) {
  console.log(JSON.stringify({ base: baseRef, next: newRef || "working tree", services: cases.length, compared, diffs, unexpected: unexpected.length }, null, 2));
} else {
  console.log(`url-sweep: ${cases.length} service cases × 2 origins × link/probe = ${compared} comparisons, base ${baseRef}, new ${newRef || "working tree"}`);
  console.log(`differences: ${diffs.length} (${diffs.length - unexpected.length} intended, ${unexpected.length} unexpected)`);
  for (const diff of diffs) {
    console.log(`  ${diff.intended ? `intended:${diff.intended}` : "UNEXPECTED"} · ${diff.host} · ${diff.source} · ${diff.service} · ${diff.origin} dashboard · ${diff.field}: ${diff.main} → ${diff.next}`);
  }
  for (const rule of INTENDED) {
    if (diffs.some(diff => diff.intended === rule.id)) console.log(`  [${rule.id}] ${rule.reason}`);
  }
}
process.exit(unexpected.length ? 1 : 0);
