#!/usr/bin/env node
// Rendering checks for every sentence the board says about its services (HOSTD-83 gate
// round 3), no browser needed.
//
// Runs the page's own STRINGS, t(), localize(), joinNames(), `<evidence-core>` and
// `<claims>` blocks in a bare VM, derives every card from a status artifact and probe
// results exactly as the page does, and renders headline, subline, "What now?" steps,
// recovery sheets and screen-reader states for family AND operator audiences, in
// English AND German. Boards: small synthetic ones whose expected sentences are written
// out literally (the gate's examples), and every real hosts/*/config.js under the same
// scenarios, where invariants must hold:
//
//   - "not running" only when a host row says a service is not running;
//   - a running-state count counts running rows (faults and unreachable ones included),
//     never the LED colour;
//   - no sentence names a cause for "unreachable" ("the path is broken, not the
//     service", "only this device"), and "answers on the host" only with the host's
//     own HTTP evidence for every one of them;
//   - "works as usual" is never said (reachability is not health);
//   - every key the claims use exists in both languages.
//
// Then the claim inventory (scripts/claims.mjs) is re-extracted and checked, including
// its self-test. Every check runs; failures are listed together and the exit code is 1.
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import vm from "node:vm";
import { cut, marked, stringsOf } from "./page-source.mjs";
import { extract, checkInventory, selfTest } from "./claims.mjs";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const indexPath = process.env.HOSTDASH_INDEX || join(repoRoot, "public", "index.html");
const html = await readFile(indexPath, "utf8");

const results = [];
const failures = [];
const check = (name, condition, detail) => {
  let ok = false;
  try { ok = typeof condition === "function" ? Boolean(condition()) : Boolean(condition); } catch (error) { detail = { error: String(error), detail }; }
  if (ok) results.push(name);
  else failures.push(`${name}: ${JSON.stringify(detail)}`.slice(0, 900));
};
const finish = () => {
  if (failures.length) {
    console.error(`test-claims: ${failures.length} of ${failures.length + results.length} checks FAILED\n${failures.map(line => `  ✗ ${line}`).join("\n")}`);
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, checks: results.length }, null, 2));
};

let api;
try {
  const sandbox = { URL, setTimeout, clearTimeout, Promise, Map, Set, Number, String, Math, Boolean, Array, Object };
  vm.runInNewContext([
    stringsOf(html).source, 'let language = "en";', cut(html, "t"), cut(html, "localize"), cut(html, "joinNames"),
    marked(html, "evidence-core"), marked(html, "claims"),
    "this.api = { STRINGS, t, localize, joinNames, core: EvidenceCore, Claims, setLanguage: next => { language = next; } };",
  ].join("\n"), sandbox);
  api = sandbox.api;
} catch (error) {
  check("the page has a DOM-free claims block to render", false, String(error));
  finish();
}
const { STRINGS, core, Claims } = api;

// ── a board, rendered ───────────────────────────────────────────────────────
const now = () => Math.floor(Date.now() / 1000);
const missingKeys = new Set();
const say = lang => (key, vars) => {
  if (!(key in STRINGS[lang])) missingKeys.add(`${lang}:${key}`);
  return api.t(key, vars);
};
// The expected sentence, straight from STRINGS (a missing key can never match).
const want = (lang, key, vars = {}) => (STRINGS[lang][key] ?? `«no ${key}»`).replace(/\{(\w+)\}/g, (match, name) => vars[name] ?? match);

// services: raw config entries; page: the dashboard URL they resolve on.
function prepare(rawServices, page = "http://board.lan/index.html") {
  return rawServices.map((raw, index) => {
    const url = core.resolveTarget(raw, page);
    return { raw, key: `s${index}`, active: raw.passive !== true, url, model: core.serviceModel(raw, url) };
  });
}

// The healthy artifact for these services: every row running, every self-report ok.
function healthy(services) {
  const status = { schema: "inspr.hostdash.status.v1", generated: now() - 5, containers: {}, units: {}, extras: {}, http: {} };
  for (const { raw } of services) {
    if (raw.container) status.containers[raw.container] = { running: true };
    if (raw.unit) status.units[raw.unit] = { running: true, active: "active" };
    if (raw.extra) status.extras[raw.extra] = { health: "OK", desired_volume: 40 };
  }
  return status;
}
const reachedAll = services => Object.fromEntries(services.filter(s => s.model.probeUrl).map(s => [s.key, { ok: true, kind: "ok" }]));

// Renders everything the board says, in one language and audience.
function render(services, { status, probes = {}, truth = "live", truthKey = "liveStatus", family, lang, contact = "Markus", groups = 1 }) {
  api.setLanguage(lang);
  const c = { t: say(lang), join: api.joinNames, family, truth: { state: truth, key: truthKey }, statusPath: "./status/status.json", groups, contact };
  const items = services.map(service => ({
    service, name: api.localize(service.raw.name), active: service.active, url: service.url, probeUrl: service.model.probeUrl,
    ev: core.derive(service.model, { truth, status: truth === "live" ? status : null, probe: probes[service.key] || null }),
  }));
  const m = Claims.summarize(items, truth, family);
  const guide = Claims.guide(m, c);
  return {
    m, items,
    headline: Claims.headline(m, c).replace(Claims.LIVE, "7"),
    subline: Claims.subline(m, c),
    guide: guide ? guide.steps : [],
    action: guide ? guide.action : null,
    sheets: Object.fromEntries(m.away.map(item => [item.name, Claims.sheet(item, c)])),
    sr: Object.fromEntries(items.map(item => [item.name, Claims.srState(item.ev, c)])),
    explain: Object.fromEntries(items.map(item => [item.name, Claims.explain(item.ev, c)])),
  };
}
const said = r => [r.headline, r.subline, ...r.guide, ...Object.values(r.sheets).flatMap(sheet => [sheet.lead, ...sheet.steps, sheet.check]), ...Object.values(r.explain)].filter(Boolean);

// ── invariants, on every rendering ──────────────────────────────────────────
const NOT_RUNNING = { en: [/not running/i], de: [/l(a|ä)uf(t|en) (gerade )?nicht\b/i] };
const CAUSES = [/broken, not the service/i, /only this device/i, /only this browser cannot/i, /gestört, nicht der Dienst/i, /nur dieses Gerät/i, /nur dieser Browser/i];
const HEALTH_FROM_REACH = [/work as usual/i, /funktionieren normal/i];
function invariants(label, r, lang) {
  const text = said(r);
  const stopped = r.m.bad.some(item => item.ev.s === "stopped");
  const notRunning = text.filter(line => NOT_RUNNING[lang].some(re => re.test(line)));
  check(`${label}: "not running" only when a host row says so`, stopped || !notRunning.length, { notRunning, bad: r.m.bad.map(item => [item.name, item.ev.s]) });
  const causes = text.filter(line => CAUSES.some(re => re.test(line)));
  check(`${label}: no sentence names a cause for "unreachable"`, !causes.length, causes);
  check(`${label}: reachability is never said as health`, !text.some(line => HEALTH_FROM_REACH.some(re => re.test(line))), text);
  if (r.m.family && r.m.v === "bad" && r.items.some(item => typeof item.ev.run === "boolean")) {
    const running = r.items.filter(item => item.ev.run === true).length;
    const expected = want(lang, "s_badF", { r: running, n: r.m.n });
    check(`${label}: the running count counts running rows`, r.subline.startsWith(expected), { subline: r.subline, expected });
  }
  const answering = [want(lang, "s_awayHostOkO")];
  if (text.some(line => answering.some(words => line.includes(words)))) {
    check(`${label}: "answers on the host" only with the host's HTTP evidence for every one`,
      r.m.away.every(item => item.ev.l === "split" && item.ev.hostOk), r.m.away.map(item => [item.name, item.ev.l, item.ev.hostOk]));
  }
}

const audiences = [["family", true], ["operator", false]];
const langs = ["en", "de"];

// ── the gate's examples, on small boards, said literally ──────────────────────
const web = name => ({ wing: "w", name, container: name.toLowerCase(), url: `http://board.lan:${8000 + name.length}/` });
{
  // Three containers, all running per host; two answer the host's HTTP check with 503.
  const services = prepare([web("Alpha"), web("Bravo"), web("Charlie")]);
  const status = healthy(services);
  status.http = { alpha: { code: 503 }, bravo: { code: 503 } };
  const expect = {
    family: { en: ["2 services report a fault", "3 of 3 services are running, says the host."], de: ["2 Dienste melden eine Störung", "3 von 3 Diensten laufen laut Gerät."] },
    operator: { en: ["2 of 3 services failing", ""], de: ["2 von 3 Diensten gestört", ""] },
  };
  for (const [audience, family] of audiences) for (const lang of langs) {
    const r = render(services, { status, probes: reachedAll(services), family, lang });
    const label = `two HTTP 503 under running containers (${audience}, ${lang})`;
    check(`${label}: headline and subline`, r.headline === expect[audience][lang][0] && r.subline === expect[audience][lang][1], { headline: r.headline, subline: r.subline });
    check(`${label}: the faulted cards say HTTP 503, and run per host`, r.items.slice(0, 2).every(item => item.ev.word === "httpStatus" && item.ev.vars.code === 503 && item.ev.run === true), r.items.map(item => item.ev));
    invariants(label, r, lang);
  }
}

{
  // Failed jobs under running units (and a running container).
  const services = prepare([
    { wing: "w", name: "Backup", unit: "backup.service", passive: true },
    { wing: "w", name: "Sync", unit: "sync.timer", passive: true },
    web("Portal"),
  ]);
  const status = healthy(services);
  status.jobs = { "backup.service": { ok: false, last: now() - 3600 }, "sync.timer": { ok: false } };
  const expect = {
    family: { en: ["2 services report a fault", "3 of 3 services are running, says the host."], de: ["2 Dienste melden eine Störung", "3 von 3 Diensten laufen laut Gerät."] },
    operator: { en: ["2 of 3 services failing", ""], de: ["2 von 3 Diensten gestört", ""] },
  };
  for (const [audience, family] of audiences) for (const lang of langs) {
    const r = render(services, { status, probes: reachedAll(services), family, lang });
    const label = `failed jobs under running units (${audience}, ${lang})`;
    check(`${label}: headline and subline`, r.headline === expect[audience][lang][0] && r.subline === expect[audience][lang][1], { headline: r.headline, subline: r.subline });
    invariants(label, r, lang);
  }
  // One failed job: named as what it is.
  const one = healthy(services);
  one.jobs = { "backup.service": { ok: false } };
  for (const lang of langs) {
    const r = render(services, { status: one, probes: reachedAll(services), family: true, lang });
    check(`one failed job under a running unit (family, ${lang}): named as the failed run`,
      r.headline === want(lang, "h_bad1Fault", { name: "Backup", word: want(lang, "jobFailed") }), r.headline);
    invariants(`one failed job (family, ${lang})`, r, lang);
  }
}

{
  // One stopped, one fault, one fine.
  const services = prepare([web("Alpha"), web("Bravo"), web("Charlie")]);
  const status = healthy(services);
  status.containers.alpha = { running: false };
  status.http = { bravo: { code: 503 } };
  const expect = {
    family: { en: ["2 services with problems: 1 down, 1 with a fault", "2 of 3 services are running, says the host."], de: ["2 Dienste mit Problemen: 1 ausgefallen, 1 gestört", "2 von 3 Diensten laufen laut Gerät."] },
    operator: { en: ["2 of 3 services failing", ""], de: ["2 von 3 Diensten gestört", ""] },
  };
  for (const [audience, family] of audiences) for (const lang of langs) {
    const r = render(services, { status, probes: reachedAll(services), family, lang });
    const label = `one stopped plus one fault (${audience}, ${lang})`;
    check(`${label}: headline and subline`, r.headline === expect[audience][lang][0] && r.subline === expect[audience][lang][1], { headline: r.headline, subline: r.subline });
    invariants(label, r, lang);
  }
  // Each alone: the stopped one is "not running", the fault is named.
  for (const lang of langs) {
    const stoppedOnly = healthy(services);
    stoppedOnly.containers.alpha = { running: false };
    const a = render(services, { status: stoppedOnly, probes: reachedAll(services), family: true, lang });
    check(`one stopped (family, ${lang}): not running`, a.headline === want(lang, "h_bad1Stopped", { name: "Alpha" }), a.headline);
    const faultOnly = healthy(services);
    faultOnly.http = { bravo: { code: 503 } };
    const b = render(services, { status: faultOnly, probes: reachedAll(services), family: true, lang });
    check(`one fault (family, ${lang}): reports HTTP 503, not "not running"`, b.headline === want(lang, "h_bad1Fault", { name: "Bravo", word: "HTTP 503" }), b.headline);
    invariants(`one fault (family, ${lang})`, b, lang);
  }
}

{
  // A running row, no host HTTP measurement, and a failed browser probe: running per
  // host and unreachable from here, nothing about where it fails.
  const services = prepare([web("Alpha"), web("Bravo")]);
  const status = healthy(services);
  const probes = { s0: { ok: false, kind: "network" }, s1: { ok: true, kind: "ok" } };
  for (const [audience, family] of audiences) for (const lang of langs) {
    const r = render(services, { status, probes, family, lang });
    const label = `running row, no host HTTP, failed probe (${audience}, ${lang})`;
    const sheet = r.sheets.Alpha;
    if (family) {
      check(`${label}: says running per host and unreachable, nothing more`,
        r.headline === want(lang, "h_away1", { name: "Alpha" }) && r.subline === want(lang, "s_awayHostF"), { headline: r.headline, subline: r.subline });
      check(`${label}: guidance retries, checks the network, then asks`,
        JSON.stringify(r.guide) === JSON.stringify([want(lang, "g_retry"), want(lang, "g_wifi"), want(lang, "g_still", { name: "Markus" })]) && r.action === "retry", r.guide);
      check(`${label}: the sheet says the same`, sheet?.lead === want(lang, "shAwayHostF"), sheet);
    } else {
      check(`${label}: says running per host and unreachable, nothing more`,
        r.headline === want(lang, "h_awayOp1", { name: "Alpha" }) && r.subline === want(lang, "s_awayHostO"), { headline: r.headline, subline: r.subline });
      check(`${label}: the sheet claims no host answer and asks to check the service first`,
        sheet?.lead === want(lang, "shAwayHostO") && sheet.check === want(lang, "shAwayOpsHost"), sheet);
      check(`${label}: no host-answer explanation on the card`, r.explain.Alpha === "", r.explain);
    }
    check(`${label}: the screen reader hears the browser's word and the host's running state`,
      r.sr.Alpha === want(lang, "srState", { word: want(lang, "status_unreachable"), src: want(lang, "src_split") }), r.sr.Alpha);
    invariants(label, r, lang);
  }
  // The literal operator sentence of the finding, both languages.
  const en = render(services, { status, probes, family: false, lang: "en" });
  const de = render(services, { status, probes, family: false, lang: "de" });
  check("running row, no host HTTP, failed probe: operator subline, literally",
    en.subline === "Running per host; unreachable from this browser." && de.subline === "Laut Gerät in Betrieb; von diesem Browser nicht erreichbar.", [en.subline, de.subline]);
  // A probe that timed out is "no answer in time", not "no connection".
  const timedOut = core.derive(services[0].model, { truth: "live", status, probe: { ok: false, kind: "timeout" } });
  check("a timed-out probe is no answer in time, not no connection",
    timedOut.ev.some(e => e.key === "ev_browserTimeout") && !timedOut.ev.some(e => e.key === "ev_noConnection"), timedOut.ev);

  // With the host's own HTTP check answering: that, and only that, is said in addition.
  const answered = healthy(services);
  answered.http = { alpha: { code: 200 } };
  for (const lang of langs) {
    const r = render(services, { status: answered, probes, family: false, lang });
    check(`running, host HTTP 200, failed probe (operator, ${lang}): adds the host's answer`,
      r.subline === `${want(lang, "s_awayHostO")} ${want(lang, "s_awayHostOkO")}`, r.subline);
    check(`running, host HTTP 200, failed probe (operator, ${lang}): sheet names the code, ops list skips the host check`,
      r.sheets.Alpha?.lead === `${want(lang, "shAwayHostO")} ${want(lang, "shHostOk", { code: 200 })}` && r.sheets.Alpha.check === want(lang, "shAwayOps"), r.sheets.Alpha);
    check(`running, host HTTP 200, failed probe (operator, ${lang}): the card explains the host's answer`,
      r.explain.Alpha === want(lang, "hostOkExplanation", { code: 200 }), r.explain);
    invariants(`running, host HTTP 200, failed probe (operator, ${lang})`, r, lang);
  }
  // One host-confirmed, one without any host word: counted apart.
  const mixedServices = prepare([web("Alpha"), web("Bravo"), web("Charlie")]);
  const mixed = healthy(mixedServices);
  delete mixed.containers.bravo;
  for (const lang of langs) {
    const r = render(mixedServices, { status: mixed, probes: { s0: { ok: false, kind: "network" }, s1: { ok: false, kind: "network" }, s2: { ok: true, kind: "ok" } }, family: false, lang });
    check(`one running and one unreported, both unreachable (operator, ${lang}): counted apart`,
      r.subline === want(lang, "s_awayMixO", { s: 1, a: 1 }) && r.sheets.Bravo?.lead === want(lang, "shAwayOnly"), { subline: r.subline, sheets: r.sheets });
    invariants(`mixed unreachable (operator, ${lang})`, r, lang);
    const f = render(mixedServices, { status: mixed, probes: { s0: { ok: false, kind: "network" }, s1: { ok: false, kind: "network" }, s2: { ok: true, kind: "ok" } }, family: true, lang });
    check(`one running and one unreported, both unreachable (family, ${lang}): only what holds for both`, f.subline === want(lang, "s_awayOnlyF"), f.subline);
  }
}

{
  // Mixed counts: running, a finished job, a fault.
  const services = prepare([
    web("Alpha"), web("Bravo"),
    { wing: "w", name: "Backup", unit: "backup.service", passive: true },
    { wing: "w", name: "Broker", container: "broker", passive: true },
  ]);
  const status = healthy(services);
  status.units["backup.service"] = { running: false, active: "inactive", type: "oneshot" };
  status.jobs = { "backup.service": { ok: true, last: now() - 600 } };
  status.http = { bravo: { code: 503 } };
  const expect = {
    family: {
      en: ["Bravo reports: HTTP 503", "3 of 4 services are running, says the host. Last run ok: Backup."],
      de: ["Bravo meldet: HTTP 503", "3 von 4 Diensten laufen laut Gerät. Letzter Lauf ok: Backup."],
    },
    operator: { en: ["1 of 4 services failing", ""], de: ["1 von 4 Diensten gestört", ""] },
  };
  for (const [audience, family] of audiences) for (const lang of langs) {
    const r = render(services, { status, probes: reachedAll(services), family, lang });
    const label = `mixed running, finished job and fault (${audience}, ${lang})`;
    check(`${label}: headline and subline`, r.headline === expect[audience][lang][0] && r.subline === expect[audience][lang][1], { headline: r.headline, subline: r.subline });
    invariants(label, r, lang);
  }
  const ok = healthy(services);
  ok.units["backup.service"] = { running: false, active: "inactive", type: "oneshot" };
  ok.jobs = { "backup.service": { ok: true, last: now() - 600 } };
  for (const [audience, family] of audiences) for (const lang of langs) {
    const r = render(services, { status: ok, probes: reachedAll(services), family, lang });
    check(`mixed running and finished job, no fault (${audience}, ${lang}): counted apart`,
      r.headline === want(lang, "h_okJobs", { n: 4, r: 3, j: 1 }), r.headline);
    invariants(`running and finished job (${audience}, ${lang})`, r, lang);
  }
}

{
  // A same-origin 502 with no host truth at all: a measured fault, not "not running",
  // and no running count the host never gave.
  const services = prepare([{ wing: "w", name: "Recordings", container: "media", sameHost: true, path: "/rec/" }, web("Alpha")]);
  for (const lang of langs) {
    const r = render(services, { status: null, truth: "none", truthKey: "noArtifact", probes: { s0: { ok: false, kind: "http", code: 502 }, s1: { ok: true, kind: "ok" } }, family: true, lang });
    check(`browser-measured 502 without host truth (family, ${lang}): reports the code`,
      r.headline === want(lang, "h_bad1Fault", { name: "Recordings", word: "HTTP 502" }) && !r.subline.includes(want(lang, "s_badF", { r: 0, n: 2 })), { headline: r.headline, subline: r.subline });
    invariants(`browser-measured 502 (family, ${lang})`, r, lang);
  }
}

{
  // Operator ok: "with a web UI" counts services with a link, whether probed or not.
  const services = prepare([web("Alpha"), { ...web("Bravo"), probe: false }, { wing: "w", name: "Broker", container: "broker", passive: true }]);
  for (const lang of langs) {
    const r = render(services, { status: healthy(services), probes: reachedAll(services), family: false, lang, groups: 1 });
    check(`operator ok (${lang}): web UIs counted by link`, r.subline === want(lang, "s_okO", { h: 3, u: 2, w: 1 }), r.subline);
  }
}

{
  // A tile's foot claims "no web UI" only when the tile has no link.
  for (const lang of langs) {
    const c = { t: say(lang) };
    api.setLanguage(lang);
    check(`tile foot (${lang}): a linked service without port or path never says "no web UI"`, Claims.foot("", "http://board.lan/", c) === "", Claims.foot("", "http://board.lan/", c));
    check(`tile foot (${lang}): a service without a link says "no web UI"`, Claims.foot("", null, c) === want(lang, "noUi"), Claims.foot("", null, c));
    check(`tile foot (${lang}): a configured foot is kept`, Claims.foot(":8123", null, c) === ":8123", {});
  }
}

// ── every real board, as family and as operator, under the same scenarios ──────
const hosts = (await readdir(join(repoRoot, "hosts"))).filter(name => existsSync(join(repoRoot, "hosts", name, "config.js"))).sort();
const configOf = async host => {
  const sandbox = { window: {} };
  vm.runInNewContext(await readFile(join(repoRoot, "hosts", host, "config.js"), "utf8"), sandbox);
  return sandbox.window.HOSTDASH_CONFIG;
};
for (const host of hosts) {
  const config = await configOf(host);
  const raw = config.services.filter(service => config.wings.some(wing => wing.id === service.wing));
  const services = prepare(raw, `http://${host}.lan/index.html`);
  const groups = new Set(raw.map(service => service.wing)).size;
  const bound = services.filter(service => service.raw.container || service.raw.unit);
  const containers = bound.filter(service => service.raw.container);
  const unreachable = services.find(service => service.model.probeUrl && (service.raw.container || service.raw.unit));
  const finished = services.find(service => service.raw.passive === true && /\.service$/.test(service.raw.unit || ""));
  const keyOf = service => service.raw.httpKey || service.raw.container || service.raw.unit;
  const scenarios = {
    healthy: () => ({ status: healthy(services) }),
    "two HTTP 503 under running containers": () => {
      const status = healthy(services);
      containers.slice(0, 2).forEach(service => { status.http[keyOf(service)] = { code: 503 }; });
      return { status };
    },
    "failed jobs under running units": () => {
      const status = healthy(services);
      status.jobs = Object.fromEntries(bound.slice(0, 2).map(service => [service.raw.unit || service.raw.container, { ok: false }]));
      return { status };
    },
    "one stopped plus one fault": () => {
      const status = healthy(services);
      const [a, b] = containers;
      status.containers[a.raw.container] = { running: false };
      status.http[keyOf(b)] = { code: 503 };
      return { status };
    },
    "running row, no host HTTP, failed probe": () => ({ status: healthy(services), fail: unreachable?.key }),
    "running row, host HTTP 200, failed probe": () => {
      const status = healthy(services);
      if (unreachable) status.http[keyOf(unreachable)] = { code: 200 };
      return { status, fail: unreachable?.key };
    },
    "mixed running, finished job and fault": () => {
      const status = healthy(services);
      const job = finished || bound.find(service => service.raw.passive === true && service !== containers[0]);
      if (job) {
        const jobKey = job.raw.unit || job.raw.container;
        if (finished) status.units[finished.raw.unit] = { running: false, active: "inactive", type: "oneshot" };
        else if (job.raw.container) delete status.containers[job.raw.container];
        else delete status.units[job.raw.unit];
        status.jobs = { [jobKey]: { ok: true } };
      }
      status.http[keyOf(containers[0])] = { code: 503 };
      return { status };
    },
    "status file stale": () => ({ status: null, truth: "stale", truthKey: "staleStatus" }),
    "no status file": () => ({ status: null, truth: "none", truthKey: "noArtifact" }),
  };
  for (const [name, make] of Object.entries(scenarios)) {
    const { status, truth = "live", truthKey = "liveStatus", fail = null } = make();
    const probes = reachedAll(services);
    if (fail) probes[fail] = { ok: false, kind: "network" };
    for (const [audience, family] of audiences) for (const lang of langs) {
      const r = render(services, { status, truth, truthKey, probes, family, lang, groups });
      invariants(`${host} ${name} (${audience}, ${lang})`, r, lang);
      if (name === "two HTTP 503 under running containers") {
        check(`${host} ${name} (${audience}, ${lang}): headline counts the faults`,
          r.headline === (family ? want(lang, "h_badManyFault", { b: 2 }) : want(lang, "h_badOp", { b: 2, n: services.length })), r.headline);
      }
      if (name === "running row, no host HTTP, failed probe" && unreachable) {
        check(`${host} ${name} (${audience}, ${lang}): running per host and unreachable, nothing more`,
          r.subline === want(lang, family ? "s_awayHostF" : "s_awayHostO"), r.subline);
      }
    }
  }
}

check("every key the claims render exists in both languages", missingKeys.size === 0, [...missingKeys]);

// ── the claim inventory ─────────────────────────────────────────────────────
{
  const extracted = extract(html);
  const problems = checkInventory(extracted);
  check("claim inventory: every rendered key is inventoried, every inventoried key is rendered", problems.length === 0, problems);
  const self = selfTest(html);
  check("claim inventory self-test: an unlisted key fails the check", self.unlistedCaught, self);
  check("claim inventory self-test: a vanished key fails the check", self.vanishedCaught, self);
}

finish();
