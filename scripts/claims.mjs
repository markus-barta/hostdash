#!/usr/bin/env node
// The claim inventory (HOSTD-83 gate r3): every user-visible string key the board can
// render, what it claims, and the evidence condition under which it is rendered.
//
// EXTRACTION RULE (run by the script, never written by hand):
//   keys   every key of STRINGS.en and STRINGS.de in public/index.html (the two key sets
//          must be equal);
//   sites  every line of public/index.html where a key is rendered: a data-i18n,
//          data-i18n-aria, data-i18n-title or data-i18n-placeholder attribute in the
//          markup, or, in the page's module script outside the STRINGS declaration, a
//          string literal equal to the key ("key", 'key', `key`) that is not compared
//          or assigned as data (`=== "list"`, `filter = "all"`, `case "retry":` do not
//          count), or a template literal with one substitution whose fixed prefix ends
//          in "_" or whose fixed suffix starts upper-case (`src_${…}`, `why_${…}`,
//          `health_${…}`, `${…}Undated`): every key with that prefix/suffix is rendered
//          there.
// The INVENTORY below gives each key its claim and evidence condition. The check fails
// for a key without an inventory row, an inventory row without a key, a key in only one
// language, and a key the page never renders.
//
//   node scripts/claims.mjs              # the inventory as a markdown table
//   node scripts/claims.mjs --check      # exit 1 on any problem
//   node scripts/claims.mjs --self-test  # proves the check catches an unlisted and a vanished key
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stringsOf } from "./page-source.mjs";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const PAGE = "public/index.html";

// What a key may claim, in the gate's terms. A row names one of these, then the
// condition. "none" = chrome or guidance: the text states no service status.
export const CLAIMS = ["running", "stopped", "failed", "finished ok", "healthy", "reachable from this browser", "unreachable from this browser",
  "no evidence", "status file", "count", "evidence detail", "possible cause (hedged)", "legend", "none"];

// key: [claim, evidence condition]. Condition names the deciding code (function in
// public/index.html); the extracted sites give its lines.
const host = "a valid host row (boolean `running`) in a live artifact";
export const INVENTORY = {
  // ── chrome: labels and controls, no status claim ──
  skip: ["none", "always (skip link)"],
  language: ["none", "always (language switch label)"],
  dark: ["none", "always (appearance switch label)"],
  services: ["none", "section heading when the config's heading is the stock word (headingOf)"],
  serviceRole: ["none", "host role fallback when the config has none (renderHost)"],
  searchServices: ["none", "always (search label, placeholder)"],
  searchHint: ["none", "always (search description)"],
  groups: ["none", "always (rail label)"],
  all: ["count", "rail group; its number counts every configured service (renderRail: m.n)"],
  problems: ["failed", "rail group shown only while m.bad.length > 0; its number is m.bad.length (renderRail)"],
  size: ["none", "always (size control label)"],
  zoomOut: ["none", "always"], zoomIn: ["none", "always"], zoomRange: ["none", "always"],
  fit: ["none", "always"], fitAll: ["none", "always"], resetZoom: ["none", "always"],
  density: ["none", "always (layout switch label)"], tiles: ["none", "always"], list: ["none", "always"],
  nIn: ["count", "configured services and groups (renderHost: SERVICES.length, WINGS_USED.length)"],
  nInOne: ["count", "configured services when one group is used (renderHost)"],
  count: ["count", "cards shown under the current filter or search (applyFilter)"],
  clear: ["none", "a filter or search is active, or nothing matches (applyFilter)"],
  noMatch: ["none", "the search matches no card (applyFilter)"],
  noneInFilter: ["none", "the selected group shows no card (applyFilter)"],
  open: ["none", "an active tile whose card is not lit red (paintItem: !isBad)"],
  openAnyway: ["failed", "an active tile whose card is lit red (paintItem: isBad), and the recovery sheet's link (sheetHTML: card unreachable)"],
  srOpen: ["none", "accessible name of an active card (paintItem)"],
  noUi: ["none", "a passive card's foot when the config gives none (tileHTML)"],
  close: ["none", "recovery sheet close button (sheetHTML)"],
  today: ["evidence detail", "a job record's `last` is today (whenWord)"],
  yesterday: ["evidence detail", "a job record's `last` was yesterday (whenWord)"],
  ageSeconds: ["status file", "the artifact's age under 90 s (fmtAge)"],
  ageMinutes: ["status file", "the artifact's age 90 s – 90 min (fmtAge)"],
  ageHours: ["status file", "the artifact's age from 90 min (fmtAge)"],
  reload: ["none", "family guide action on bad/quiet (Claims.guide action reload), size reset button"],
  reloadStatus: ["none", "operator next step while the artifact is not evidence (attHTML: v quiet)"],
  retry: ["none", "family guide action on notice (Claims.guide action retry), recovery sheet"],
  att: ["failed", "operator attention list exists: v bad (m.bad + m.away), notice (m.away) or partial (reached + none) (attHTML)"],
  attLabel: ["evidence detail", "each attention chip: its card's word and evidence (attHTML)"],
  next: ["none", "operator next step on v quiet or empty (attHTML)"],
  gTitle: ["none", "family guide exists: v bad, notice, quiet or empty (Claims.guide)"],
  blankF: ["none", "family board with no configured service (renderServices)"],
  blankO: ["none", "operator board with no configured service (renderServices)"],
  configMissing: ["none", "no usable config.js or manifest (CONFIG load failed)"],
  fLegend: ["none", "always (footer)"], fHost: ["none", "always (footer)"], fHelp: ["none", "always (footer)"],
  idName: ["none", "footer host facts"], idOs: ["none", "footer host facts"], idAddr: ["none", "footer host facts"],
  idTz: ["none", "footer host facts"], idCfg: ["none", "footer host facts"], idStatus: ["none", "footer host facts"],
  statusEvery: ["none", "always (footer: the artifact contract, 60 s, 5 min limit)"],
  helpF: ["none", "family footer with a contact (renderFoot)"],
  helpNeutral: ["none", "family footer without a contact (renderFoot)"],
  helpO: ["none", "operator footer: describes the status model (renderFoot)"],

  // ── card words: what one card claims ──
  status_running: ["running", `${host} says running:true and nothing failed (deriveFrom: hostCard, no job record)`],
  status_reachable: ["reachable from this browser", "no valid running row, this browser's probe got an answer (deriveFrom: result.ok, l ring)"],
  status_unreachable: ["unreachable from this browser", "this browser's probe failed, timed out, or got 401/403 from this dashboard's server (deriveFrom: split under a running row, aring without one)"],
  status_stopped: ["stopped", `${host} says running:false, and it is not an identified oneshot service idle after an ok run (deriveFrom: s stopped)`],
  status_down: ["failed", "no running row and this dashboard's own server answered the probe 404/5xx (deriveFrom: result.kind http, s down; code kept in vars and evidence)"],
  status_muted: ["healthy", "the service's own report: health OK and desired_volume 0 (deriveFrom: self-report, s muted)"],
  listening: ["healthy", "the service's own report: health \"OK\" (deriveFrom: self-report, s up)"],
  noAnswer: ["failed", "the host's loopback HTTP check got code 0/000 (hostHttp: silent)"],
  httpStatus: ["failed", "the host's loopback HTTP check got 500–599 (hostHttp: fault), or this dashboard's server answered 404/5xx under a running row or job (deriveFrom: result.kind http)"],
  jobFailed: ["failed", "a jobs record with ok:false, with or without a row (hostJob)"],
  jobOk: ["finished ok", "a jobs record with ok:true: no row, or an identified oneshot idle between runs (s jobok); or under a running row (s running)"],
  health_AUDIO_DEAD: ["failed", "the service's own report: health AUDIO_DEAD (deriveFrom: KNOWN_HEALTH)"],
  health_VIDEO_STALE: ["failed", "the service's own report: health VIDEO_STALE (deriveFrom: KNOWN_HEALTH)"],
  health_VOLUME_DRIFT: ["failed", "the service's own report: health VOLUME_DRIFT (deriveFrom: KNOWN_HEALTH)"],
  healthFault: ["failed", "the service's own report: any other non-OK health string (deriveFrom)"],

  // ── screen reader: whose word the card's word is ──
  srState: ["evidence detail", "every card with a word: \"{word}, {source}\" (Claims.srState)"],
  srNone: ["no evidence", "every card without a word, and a chip whose card has none (Claims.srState, attHTML)"],
  src_host: ["running", "the card's word comes from the host's artifact: row, job record or loopback HTTP (ev.src host, l not split)"],
  src_both: ["reachable from this browser", "running per host AND reached by this browser's probe (ev.src both)"],
  src_browser: ["evidence detail", "the card's word comes from this browser's probe alone (ev.src browser)"],
  src_self: ["healthy", "the card's word comes from the service's own report (ev.src self)"],
  src_split: ["running", "the split: the word (Unreachable) is this browser's, the host's row says running (ev.l split)"],

  // ── evidence pill / attention chip / title: the measurements themselves ──
  ev_containerRunning: ["running", `${host}, container, running:true`],
  ev_unitRunning: ["running", `${host}, unit, running:true`],
  ev_containerStopped: ["stopped", `${host}, container, running:false`],
  ev_unitStopped: ["stopped", `${host}, unit, running:false, with the host's own \`active\` state named`],
  ev_unitNotActive: ["stopped", `${host}, unit, running:false, no \`active\` field (no state invented)`],
  ev_reached: ["reachable from this browser", "running per host and this browser's probe got an answer (src both)"],
  ev_reachedOnly: ["reachable from this browser", "probe answered, no valid running row (l ring)"],
  ev_noConnection: ["unreachable from this browser", "this browser's probe failed (network error: refused, DNS, TLS) (deriveFrom: lost)"],
  ev_browserTimeout: ["unreachable from this browser", "this browser's probe got no answer within its timeout (result.kind timeout)"],
  ev_noHost: ["no evidence", "unreachable or refused without a running row or job record (deriveFrom: unvouched)"],
  ev_hostHttpOk: ["evidence detail", "split, and the host's loopback HTTP check got 100–499 (hostOk)"],
  ev_hostHttp: ["failed", "the host's loopback HTTP check got 500–599 (hostHttp fault)"],
  ev_hostSilent: ["failed", "the host's loopback HTTP check got 0/000 (hostHttp silent)"],
  ev_sameOrigin: ["failed", "this dashboard's own server answered the probe 404/5xx (result.kind http)"],
  ev_sameOriginRefused: ["unreachable from this browser", "this dashboard's own server answered the probe 401/403"],
  ev_self: ["failed", "the service's own report, health not OK (code named)"],
  ev_selfOk: ["healthy", "the service's own report, health \"OK\""],
  ev_selfMuted: ["healthy", "the service's own report, health OK, desired_volume 0"],
  ev_noTelemetry: ["no evidence", "an `extra` binding the live artifact has no object for (selfReport gap)"],
  ev_badTelemetry: ["no evidence", "an `extras` object without a non-empty string `health` (selfReport gap)"],
  ev_badRecord: ["no evidence", "a malformed row, http or jobs record, or a record that throws (recordIn/derive)"],
  ev_unitIdle: ["finished ok", "an identified oneshot (.service, type oneshot) inactive between runs, last run ok (finished)"],
  ev_jobFailed: ["failed", "a jobs record ok:false with a valid `last` (hostJob)"],
  ev_jobFailedUndated: ["failed", "a jobs record ok:false without a valid `last` (evText)"],
  ev_jobOk: ["finished ok", "a jobs record ok:true with a valid `last` (hostJob)"],
  ev_jobOkUndated: ["finished ok", "a jobs record ok:true without a valid `last` (evText)"],
  ev_checking: ["no evidence", "truth still checking (noEvidence)"],
  ev_none: ["no evidence", "every card without evidence (noEvidence)"],
  ev_whyStale: ["status file", "the artifact is older than 5 min (noEvidence, truth stale)"],
  ev_whyMissing: ["status file", "no usable artifact (noEvidence, truth none)"],
  ev_whyUnlisted: ["no evidence", "live artifact, but no row/record for this card's binding (noEvidence)"],
  ev_whyUnbound: ["no evidence", "no host binding and no probe target (noEvidence)"],
  ev_whyStatic: ["no evidence", "browser check disabled in the config, and no host row (noEvidence)"],

  // ── headline (Claims.headline), by verdict (EvidenceCore.aggregate) ──
  h_checking: ["no evidence", "v checking: truth still checking, or a probe pending with no other evidence"],
  h_okOne: ["running", "v ok, one card, host-vouched (on/dim), not a job"],
  h_okMany: ["running", "v ok: every card host-vouched (on/dim), none a job; counts m.n"],
  h_okJobOne: ["finished ok", "v ok, one card, its only evidence an ok last run"],
  h_okJobs: ["count", "v ok with jobs: r = cards vouched running (m.running), j = cards vouched by an ok last run (m.jobs)"],
  h_partial: ["count", "v partial with some vouched: ok = m.running (running only, jobs apart), of m.n"],
  h_noVouch: ["no evidence", "v partial and no card vouched by the host"],
  h_bad1Stopped: ["stopped", "family, v bad, exactly one bad card and it is stopped (host row running:false)"],
  h_bad1Fault: ["failed", "family, v bad, exactly one bad card and it is a fault (HTTP code — a browser-measured Down says its code —, no answer, failed health, failed last run)"],
  h_badManyStopped: ["stopped", "family, v bad, several bad cards, all stopped; counts them"],
  h_badManyFault: ["failed", "family, v bad, several bad cards, none stopped; counts the faults"],
  h_badMix: ["count", "family, v bad, stopped and faults: b = all bad, s = stopped, f = faults"],
  h_badOp: ["failed", "operator, v bad: b = m.bad.length of n"],
  h_away1: ["unreachable from this browser", "family, v notice, one unreachable card (split or aring)"],
  h_awayMany: ["unreachable from this browser", "family, v notice, several; counts m.away"],
  h_awayOp1: ["unreachable from this browser", "operator, v notice, one"],
  h_awayOpMany: ["unreachable from this browser", "operator, v notice, several; counts m.away"],
  h_staleF: ["status file", "family, v quiet, truth stale: the artifact's age in minutes"],
  h_staleO: ["status file", "operator, v quiet, truth stale: the artifact's age"],
  h_noneF: ["status file", "family, v quiet, truth none"],
  h_noneO: ["status file", "operator, v quiet, truth none, key noArtifact"],
  h_schemaO: ["status file", "operator, v quiet, key unknownSchema"],
  h_unreadableO: ["status file", "operator, v quiet, key probesOnly (read failed, nothing retained)"],
  h_timeO: ["status file", "operator, v quiet, key badTime (no valid or a future timestamp)"],
  h_emptyF: ["none", "family, no configured service"],
  h_emptyO: ["none", "operator, no configured service"],

  // ── subline (Claims.subline) ──
  s_okFOne: ["reachable from this browser", "family, v ok: active cards this browser reached (EvidenceCore.opens: ring, or on/dim with src both); one"],
  s_okFMany: ["reachable from this browser", "family, v ok: the same, several"],
  s_runFOne: ["running", "family, v ok: active host-only greens (runsPerHost: lit, not a job, not reached); one"],
  s_runFMany: ["running", "family, v ok: the same, several"],
  s_okO: ["count", "operator, v ok: h = vouched cards, u = active cards with a link, w = groups"],
  s_partial: ["no evidence", "v partial, or family v bad: cards without evidence (m.none), up to 3 named"],
  s_partialMany: ["no evidence", "the same, more than 3, counted"],
  s_reached: ["reachable from this browser", "v partial, or family v bad: cards only this browser reached (m.reached), up to 3"],
  s_reachedMany: ["reachable from this browser", "the same, more than 3"],
  s_jobs: ["finished ok", "v partial, or family v bad: cards vouched by an ok last run (m.jobs), up to 3"],
  s_jobsMany: ["finished ok", "the same, more than 3"],
  s_badF: ["count", "family, v bad, the artifact has a valid row for some card: r = cards whose row says running:true (ev.run), faulted or unreachable ones included; of n"],
  s_awayHostF: ["unreachable from this browser", "family, v notice, one unreachable card, host row running (split): running per host, cannot be reached from this device; no cause"],
  s_awayHostFMany: ["unreachable from this browser", "family, v notice, several, all split"],
  s_awayHostO: ["unreachable from this browser", "operator, v notice, every unreachable card split: running per host; unreachable from this browser; no cause"],
  s_awayHostOkO: ["evidence detail", "operator, the same, and every one of them has the host's loopback answer 100–499 (ev.hostOk)"],
  s_awayOnlyF: ["unreachable from this browser", "family, v notice, at least one unreachable card without a running row (aring)"],
  s_awayOnlyO: ["unreachable from this browser", "operator, v notice, every unreachable card without a running row (aring)"],
  s_awayMixO: ["count", "operator, v notice, split and aring: s = split (running per host), a = aring"],
  s_quietF: ["status file", "family, v quiet"],
  s_staleO: ["status file", "operator, v quiet, stale: u = cards with a probe"],
  s_noneO: ["status file", "operator, v quiet, none: names the reason (why_*) and u = cards with a probe; also the truth row's title"],
  why_noArtifact: ["status file", "truth key noArtifact (read answered non-2xx)"],
  why_unknownSchema: ["status file", "truth key unknownSchema"],
  why_probesOnly: ["status file", "truth key probesOnly (read failed, nothing retained)"],
  why_badTime: ["status file", "truth key badTime"],
  s_checking: ["no evidence", "v checking"],
  s_emptyF: ["none", "family, no configured service"],
  s_emptyO: ["none", "operator, no configured service"],

  // ── truth row ──
  tr_live: ["status file", "truth live"], tr_ago: ["status file", "truth live: the artifact's age"],
  tr_next: ["none", "truth live: seconds to the next sweep"], tr_now: ["none", "truth live while a sweep runs"],
  tr_stale: ["status file", "truth stale: the artifact's age"], tr_ignored: ["status file", "truth stale"],
  tr_none: ["status file", "truth none, key noArtifact"], tr_unusable: ["status file", "truth none, any other key"],
  tr_probes: ["status file", "truth none"], tr_checking: ["no evidence", "truth checking"], tr_checkingSub: ["no evidence", "truth checking"],
  tr_empty: ["none", "no configured service"], tr_emptySub: ["none", "no configured service"],
  liveExplanation: ["status file", "truth live (truth row title)"],
  missingExplanation: ["status file", "truth stale or none (truth row title): states come from this browser's checks, reachability not health"],
  hostOkExplanation: ["possible cause (hedged)", "a card with hostOk (split, loopback 100–499): running, the host gets HTTP code; reasons offered as possible, not claimed (Claims.explain)"],

  // ── "What now?" (Claims.guide, family) ──
  g_othersOne: ["reachable from this browser", "v bad: some, not all, active cards this browser reached (opens); one"],
  g_othersMany: ["reachable from this browser", "the same, several"],
  g_allOpen: ["reachable from this browser", "v bad: every active card reached by this browser (opens)"],
  g_runOne: ["running", "v bad: active host-only greens (runsPerHost); one"],
  g_runMany: ["running", "the same, several"],
  g_tell: ["none", "v bad, a contact name configured"], g_tellNeutral: ["none", "v bad, no contact"],
  g_auto: ["none", "v bad or quiet"],
  g_retry: ["none", "v notice, and every recovery sheet on a family board"],
  g_wifi: ["none", "v notice, and the family recovery sheet: a question, no claim"],
  g_still: ["none", "v notice / family sheet, a contact configured"], g_stillNeutral: ["none", "v notice / family sheet, no contact"],
  g_tryOpenOne: ["reachable from this browser", "v quiet: cards this browser reached (opens); one"],
  g_tryOpenMany: ["reachable from this browser", "the same, several"],
  g_broken: ["none", "v quiet, a contact configured"], g_brokenNeutral: ["none", "v quiet, no contact"],
  g_empty1: ["none", "v empty: the page works, no services yet"],
  g_empty2: ["none", "v empty, a contact configured"],

  // ── operator next steps ──
  nStale: ["none", "operator, v quiet, truth stale"], nNone: ["none", "operator, v quiet, truth none, other keys"],
  nTime: ["none", "operator, v quiet, key badTime"], nEmpty: ["none", "operator, no configured service"],

  // ── legend ──
  lg_on: ["legend", "always: lit green = host row running, an ok last run, or a healthy self-report"],
  lg_ring: ["legend", "always: green ring = reached from this browser, no host report"],
  lg_split: ["legend", "always: green in amber ring = running per host, not reachable from here"],
  lg_bad: ["legend", "always: lit red = a failure reported or measured"],
  lg_off: ["legend", "always: off = no evidence"],

  // ── recovery sheet (Claims.sheet), only for an unreachable card ──
  shAwayHostF: ["unreachable from this browser", "family sheet, split: running per host, this device cannot reach it; no cause"],
  shAwayHostO: ["unreachable from this browser", "operator sheet, split: running per host; unreachable from this browser"],
  shHostOk: ["evidence detail", "operator sheet, split with hostOk: the host's loopback check code"],
  shAwayOnly: ["unreachable from this browser", "sheet, aring: unreachable; whether it runs is open"],
  shAwayOps: ["none", "operator sheet with hostOk: route checks"],
  shAwayOpsHost: ["none", "operator sheet without hostOk: check the service on the host first, then the route"],
  shNote: ["none", "sheet of a card whose config has a note"],
};

// ── extraction ──────────────────────────────────────────────────────────────
export function extract(html) {
  const { source, value: strings } = stringsOf(html);
  const lines = html.split("\n");
  const at = html.indexOf(source);
  const stringsFrom = html.slice(0, at).split("\n").length;
  const stringsTo = stringsFrom + source.split("\n").length - 1;
  const moduleFrom = lines.findIndex(line => line.includes('<script type="module">')) + 1;
  const markupFrom = lines.findIndex(line => line.startsWith("<body")) + 1;
  const en = Object.keys(strings.en || {});
  const de = Object.keys(strings.de || {});
  const keys = [...new Set([...en, ...de])];
  const sites = new Map(keys.map(key => [key, []]));
  const escapeRe = text => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const add = (key, line) => { const list = sites.get(key); if (list && !list.includes(line)) list.push(line); };
  lines.forEach((text, index) => {
    const line = index + 1;
    if (line >= markupFrom && line < moduleFrom) {
      for (const found of text.matchAll(/data-i18n(?:-aria|-title|-placeholder)?="([^"]+)"/g)) add(found[1], line);
      return;
    }
    if (line < moduleFrom || (line >= stringsFrom && line <= stringsTo)) return;
    for (const key of keys) {
      const re = new RegExp(`(["'\`])${escapeRe(key)}\\1`, "g");
      for (const found of text.matchAll(re)) {
        const before = text.slice(0, found.index).trimEnd();
        const after = text.slice(found.index + found[0].length).trimStart();
        const asData = /(===|!==|==|!=|(?<![=!<>])=|\bcase)$/.test(before) || /^(===|!==|==|!=)/.test(after);
        if (!asData) add(key, line);
      }
    }
    for (const found of text.matchAll(/`([^`$]*)\$\{(?:[^`{}]|\{[^`{}]*\})*\}([^`$]*)`/g)) {
      const [, prefix, suffix] = found;
      if (!(prefix.endsWith("_") || /^[A-Z]/.test(suffix))) continue;
      for (const key of keys) if (key.length > prefix.length + suffix.length && key.startsWith(prefix) && key.endsWith(suffix)) add(key, line);
    }
  });
  return { keys, en: new Set(en), de: new Set(de), strings, sites };
}

export function checkInventory(extracted, inventory = INVENTORY) {
  const problems = [];
  for (const key of extracted.keys) {
    if (!(key in inventory)) problems.push(`unlisted key: ${key} (in STRINGS, not in the inventory)`);
    if (!extracted.en.has(key) || !extracted.de.has(key)) problems.push(`one language only: ${key}`);
    if (!extracted.sites.get(key)?.length) problems.push(`never rendered: ${key}`);
  }
  for (const key of Object.keys(inventory)) {
    if (!extracted.keys.includes(key)) problems.push(`vanished key: ${key} (in the inventory, not in STRINGS)`);
    const [claim, when] = inventory[key];
    if (!CLAIMS.includes(claim) || typeof when !== "string" || !when) problems.push(`malformed row: ${key}`);
  }
  return problems;
}

// The check must catch both directions: one key added to the page without a row, and
// one key removed from the page while its row stays.
export function selfTest(html) {
  const marker = "    skip: ";
  const added = html.replace(marker, `    zz_unlistedProbe: "unlisted", ${marker.trim()} `).replace(marker, `    zz_unlistedProbe: "nicht gelistet", ${marker.trim()} `)
    .replace("// ── ICONS", 'const zzProbe = () => t("zz_unlistedProbe");\n// ── ICONS');
  const addedProblems = checkInventory(extract(added));
  const removed = html.replace(/ shNote: "[^"]*",/g, "");
  const removedProblems = checkInventory(extract(removed));
  return {
    unlistedCaught: addedProblems.some(line => line.startsWith("unlisted key: zz_unlistedProbe")),
    vanishedCaught: removedProblems.some(line => line.startsWith("vanished key: shNote")),
    addedProblems, removedProblems,
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
const cell = text => String(text).replace(/\|/g, "\\|").replace(/\n/g, " ");
export function table(extracted, inventory = INVENTORY) {
  const rows = extracted.keys.map(key => {
    const [claim, when] = inventory[key] || ["—", "NOT IN INVENTORY"];
    const sites = extracted.sites.get(key) || [];
    return `| \`${key}\` | ${cell(extracted.strings.en[key] ?? "")} | ${cell(extracted.strings.de[key] ?? "")} | ${claim} | ${cell(when)} | ${sites.map(line => `${PAGE}:${line}`).join(", ") || "—"} |`;
  });
  return ["| key | EN | DE | claims | evidence condition | rendered at |", "| --- | --- | --- | --- | --- | --- |", ...rows].join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const html = readFileSync(process.env.HOSTDASH_INDEX || join(repoRoot, PAGE), "utf8");
  const extracted = extract(html);
  const args = process.argv.slice(2);
  let failed = false;
  if (args.includes("--check")) {
    const problems = checkInventory(extracted);
    console.log(problems.length ? `claims: ${problems.length} problems\n${problems.map(line => `  ✗ ${line}`).join("\n")}` : `claims: ok, ${extracted.keys.length} keys, all inventoried and rendered`);
    failed ||= problems.length > 0;
  }
  if (args.includes("--self-test")) {
    const self = selfTest(html);
    console.log(`claims self-test: unlisted key ${self.unlistedCaught ? "caught" : "MISSED"}, vanished key ${self.vanishedCaught ? "caught" : "MISSED"}`);
    failed ||= !self.unlistedCaught || !self.vanishedCaught;
  }
  if (!args.includes("--check") && !args.includes("--self-test")) console.log(table(extracted));
  process.exit(failed ? 1 : 0);
}
