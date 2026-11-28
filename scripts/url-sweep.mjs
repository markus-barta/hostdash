#!/usr/bin/env node
// URL compatibility sweep (HOSTD-83 gate r3, baseline frozen in gate r4): every
// service's link and probe target, resolved by the pre-rewrite board and by this
// branch's page, on an http and an https dashboard origin, and every difference listed.
//
// Inputs:
//   - the pre-rewrite board's resolution logic, frozen: scripts/fixtures/
//     url-baseline-7e4896d.js, a verbatim copy of commit 7e4896d's public/index.html
//     (serviceTargetUrl(), cleanServices() and helpers, and its render loop's link/probe
//     decision lines), run in a VM with a fake window.location. No git, no ref: once
//     this branch is main, "main" is no baseline any more (gate r4). scripts/
//     test-url-sweep.mjs proves the copy byte-identical to that commit and runs the
//     sweep as it runs after the merge.
//   - this branch's public/index.html: the whole `<evidence-core>` block plus its
//     cleanServices(), run the same way.
//   - every hosts/*/config.js, and the manifests smoke-ui.mjs serves (its own
//     manifestFromConfig(), cut out of the script) for the boards it runs in manifest
//     mode (hsb1, hsb8).
//   - for every same-host service, the scheme spellings the pre-rewrite URL setter
//     accepted ("https", "HTTPS:", "https:", "https://", "HTTP", "http:"), so the class of the r3
//     finding is swept, not only the spellings the configs happen to use today.
//
// Every difference must be classified as intended (a reason below), or the sweep fails.
//
//   node scripts/url-sweep.mjs                      # new = working tree
//   node scripts/url-sweep.mjs --new <ref|path>     # new = a page at a git ref, or a file
//   node scripts/url-sweep.mjs --json
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import vm from "node:vm";
import { cut, marked } from "./page-source.mjs";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
if (args.includes("--base")) throw new Error("--base is gone: the baseline is frozen in scripts/fixtures/url-baseline-7e4896d.js (HOSTD-83 gate r4)");
const BASELINE = "scripts/fixtures/url-baseline-7e4896d.js";
const baseName = "7e4896d (frozen)";
const newRef = opt("--new", null);
const asJson = args.includes("--json");

const gitShow = (ref, path) => execFileSync("git", ["show", `${ref}:${path}`], { cwd: repoRoot, encoding: "utf8", maxBuffer: 1 << 26 });
const readNew = path => newRef
  ? (existsSync(newRef) ? readFileSync(newRef, "utf8") : gitShow(newRef, path))
  : readFileSync(join(repoRoot, path), "utf8");

const CLEAN_HELPERS = ["isObject", "objectOr", "arrayOrEmpty", "stringOr", "isLocalizable", "localizedOr", "cleanServices"];
// The pre-rewrite board: its own functions and decision lines, frozen.
const baseSandbox = { window: { location: null }, URL };
vm.runInNewContext([readFileSync(join(repoRoot, BASELINE), "utf8"),
  "this.cleanServices = cleanServices; this.baseDecision = baseDecision;"].join("\n"), baseSandbox);
// What an <a href> / fetch() does with whatever the page assigned: resolve it on the page.
const asBrowser = (value, pageHref) => {
  try { return new URL(String(value), pageHref).href; } catch { return String(value); }
};
function baseResolve(service, pageHref) {
  baseSandbox.window.location = new URL(pageHref);
  let href = null;
  // A DOMStringMap keeps strings: `dataset.probe = undefined` reads back "undefined".
  const card = { dataset: {}, set href(value) { href = asBrowser(value, pageHref); } };
  baseSandbox.baseDecision(service, card);
  return { link: href, probe: "probe" in card.dataset ? asBrowser(card.dataset.probe, pageHref) : null };
}

// This branch: the evidence core as shipped.
const newHtml = readNew("public/index.html");
const newSandbox = { URL };
vm.runInNewContext([...CLEAN_HELPERS.map(name => cut(newHtml, name)), marked(newHtml, "evidence-core"),
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
    reason: "an active service with neither a web url nor same-host fields: the pre-rewrite board assigned `undefined` and linked/probed the page-relative path /undefined; now it gets no link and no probe (round-2 sweep)",
    test: d => d.base !== null && /\/undefined$/.test(d.base) && d.next === null,
  },
  {
    id: "non-web",
    reason: "a url that is not http(s) (javascript:, data:, file:): the pre-rewrite board linked and probed it; now neither (round-2 sweep)",
    test: d => d.base !== null && !/^https?:/.test(d.base) && d.next === null,
  },
];

const diffs = [];
let compared = 0;
for (const item of cases) {
  for (const origin of ["http", "https"]) {
    const pageHref = `${origin}://${item.host}.lan/index.html`;
    const base = baseResolve(item.base, pageHref);
    const next = newResolve(item.next, pageHref);
    for (const field of ["link", "probe"]) {
      compared += 1;
      if (base[field] === next[field]) continue;
      const diff = { host: item.host, source: item.source, service: english(item.service.name), origin, field, base: base[field], next: next[field] };
      const intended = INTENDED.find(rule => rule.test(diff));
      diffs.push({ ...diff, intended: intended?.id || null });
    }
  }
}
const unexpected = diffs.filter(diff => !diff.intended);

if (asJson) {
  console.log(JSON.stringify({ base: baseName, next: newRef || "working tree", services: cases.length, compared, diffs, unexpected: unexpected.length }, null, 2));
} else {
  console.log(`url-sweep: ${cases.length} service cases × 2 origins × link/probe = ${compared} comparisons, base ${baseName}, new ${newRef || "working tree"}`);
  console.log(`differences: ${diffs.length} (${diffs.length - unexpected.length} intended, ${unexpected.length} unexpected)`);
  for (const diff of diffs) {
    console.log(`  ${diff.intended ? `intended:${diff.intended}` : "UNEXPECTED"} · ${diff.host} · ${diff.source} · ${diff.service} · ${diff.origin} dashboard · ${diff.field}: ${diff.base} → ${diff.next}`);
  }
  for (const rule of INTENDED) {
    if (diffs.some(diff => diff.intended === rule.id)) console.log(`  [${rule.id}] ${rule.reason}`);
  }
}
process.exitCode = unexpected.length ? 1 : 0; // not exit(): a large --json on a pipe would be cut off
