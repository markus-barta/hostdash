#!/usr/bin/env node
// Unit checks for the board's evidence core (HOSTD-83), no browser needed.
//
// Same approach as smoke-ui.mjs reading STRINGS: the block between the
// `// <evidence-core>` markers in public/index.html is run as-is in a bare VM, so these
// checks exercise the shipped code, not a copy of it.
//
//   (a) probe starvation: steady sweeps that arrive faster than a slow probe must not
//       drop its result forever (HOSTD-81 replaced a per-card token on every sweep and
//       discarded every late result).
//   (b) static statuses: a config `status` / `statusPolicy.staticState` / `probe: false`
//       is a probe opt-out, never evidence. csb1's INSPR site used to show a green
//       "External" nothing had measured.
//   (r1) the HOSTD-83 gate round 1 findings: aggregate verdict and lens from evidence
//       only, readable same-origin HTTP failures under a running host, jobs read on
//       their own, same-host URLs without a redundant `url`, self-report services keep
//       their browser fallback, empty telemetry is not health, timestamps that cannot
//       age are not evidence, and probe batching really batches.
//
// Every check runs; failures are listed together and the exit code is 1.
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import vm from "node:vm";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const html = await readFile(join(repoRoot, "public", "index.html"), "utf8");
const block = html.match(/\/\/ <evidence-core>\n([\s\S]*?)\/\/ <\/evidence-core>/);
if (!block) throw new Error("Evidence core markers not found in public/index.html");
const core = vm.runInNewContext(`${block[1]}\nEvidenceCore`, {
  setTimeout, clearTimeout, Promise, Map, Set, Number, String, Math, Boolean, Array, Object, URL,
});

const results = [];
const failures = [];
const check = (name, condition, detail) => {
  let ok = false;
  try { ok = typeof condition === "function" ? Boolean(condition()) : Boolean(condition); } catch (error) { detail = { error: String(error), detail }; }
  if (ok) results.push(name);
  else failures.push(`${name}: ${JSON.stringify(detail)}`);
};
// For checks whose subject may not exist before a fix: never let one crash the run.
const safely = (fn, fallback = null) => { try { return fn(); } catch (error) { return { error: String(error), fallback }; } };
const sleep = ms => new Promise(done => setTimeout(done, ms));
const now = () => Math.floor(Date.now() / 1000);
const artifact = (sections = {}, ageSec = 0) => ({
  schema: "inspr.hostdash.status.v1", generated: now() - ageSec, containers: {}, units: {}, extras: {}, ...sections,
});
const live = status => ({ truth: "live", status });

// ── (a) probes cannot be starved ─────────────────────────────────────────────
{
  // One card, a probe that takes 250 ms, sweeps every 40 ms for 1.2 s. Under the
  // HOSTD-81 token scheme every sweep superseded the unsettled probe and its result
  // was thrown away; here the result must land, and only one probe may be in flight.
  let concurrent = 0;
  let maxConcurrent = 0;
  let calls = 0;
  const settled = [];
  const prober = core.createProber({
    fetchImpl: async () => {
      calls += 1;
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await sleep(250);
      concurrent -= 1;
      return { type: "opaque", ok: false, status: 0 };
    },
    schedule: (fn, ms) => setTimeout(fn, ms),
    cancel: id => clearTimeout(id),
    timeoutMs: 1000,
    onSettle: (key, result) => settled.push({ key, result }),
  });
  const sweep = setInterval(() => prober.request("slow", "http://slow.example/"), 40);
  prober.request("slow", "http://slow.example/");
  await sleep(1200);
  clearInterval(sweep);
  await sleep(300);
  const result = prober.result("slow");
  check("(a) a slow probe under steady faster sweeps still yields a result", result?.ok === true && settled.length >= 3,
    { result, settled: settled.length });
  check("(a) a sweep never starts a second probe for a card with one in flight", maxConcurrent === 1, { maxConcurrent, calls });
  check("(a) every started probe settles and is kept", settled.length === calls, { settled: settled.length, calls });
  check("(a) results are kept in start order", settled.every((entry, i) => i === 0 || entry.result.seq > settled[i - 1].result.seq),
    settled.map(entry => entry.result.seq));

  // The result is judged when it lands, against the truth current at that moment.
  const svc = core.serviceModel({ container: "ha", url: "http://ha.lan/" }, "http://ha.lan/");
  const running = artifact({ containers: { ha: { running: true } } });
  const judged = core.derive(svc, { ...live(running), probe: result });
  check("(a) the landed result refines the host truth current when it lands", judged.s === "up" && judged.src === "both", judged);
  const later = core.derive(svc, { ...live(artifact({ containers: { ha: { running: false } } })), probe: result });
  check("(a) a landed probe never outranks a host that now says stopped", later.s === "stopped" && later.l === "bad", later);
}

{
  // A probe whose fetch never settles (no abort support) is still bounded by the timeout.
  const prober = core.createProber({
    fetchImpl: () => new Promise(() => {}),
    schedule: (fn, ms) => setTimeout(fn, ms),
    cancel: id => clearTimeout(id),
    timeoutMs: 120,
  });
  prober.request("hung", "http://hung.example/");
  await sleep(60);
  check("(a) a hung probe is pending, not lost", prober.pending("hung") && prober.result("hung") === null, {});
  await sleep(150);
  check("(a) a hung probe settles as a timeout and frees the card", !prober.pending("hung") && prober.result("hung")?.kind === "timeout",
    prober.result("hung"));
}

{
  // Fairness: 23 cards, a queue that drains 5 every 60 ms, sweeps every 50 ms that keep
  // re-requesting everything. The tail of the queue must not starve either, and the
  // queue must actually batch: 5 start at once, the rest in later batches (HOSTD-83 gate
  // r1 L1: a synchronous pump started all 23 at once).
  const seen = new Set();
  const startedAt = new Map();
  const t0 = Date.now();
  const prober = core.createProber({
    fetchImpl: async url => { seen.add(url); if (!startedAt.has(url)) startedAt.set(url, Date.now() - t0); await sleep(30); return { type: "opaque" }; },
    schedule: (fn, ms) => setTimeout(fn, ms),
    cancel: id => clearTimeout(id),
    timeoutMs: 1000, batch: 5, gapMs: 60,
  });
  const keys = Array.from({ length: 23 }, (_, i) => `c${i}`);
  const sweep = () => keys.forEach(key => prober.request(key, `http://${key}.example/`));
  sweep();
  const timer = setInterval(sweep, 50);
  await sleep(700);
  clearInterval(timer);
  await sleep(200);
  check("(a) a sweep cadence faster than the probe queue never starves the tail", keys.every(key => prober.result(key)?.ok),
    keys.filter(key => !prober.result(key)));
  const firstStarts = keys.map(key => startedAt.get(`http://${key}.example/`)).sort((x, y) => x - y);
  const firstBatch = firstStarts.filter(ms => ms < firstStarts[0] + 30).length;
  check("(r1 L1) a sweep's probes start in batches of 5, not all at once", firstBatch === 5, { firstBatch, firstStarts });
  check("(r1 L1) the queued tail starts batches later (>= 4 gaps after the first)", firstStarts[22] - firstStarts[0] >= 4 * 60 - 15, { firstStarts });
}

{
  // A same-origin, readable non-2xx (this dashboard's own nginx) is a failure, not reachability.
  const prober = core.createProber({
    fetchImpl: async () => ({ type: "basic", ok: false, status: 502 }),
    schedule: (fn, ms) => setTimeout(fn, ms), cancel: id => clearTimeout(id), timeoutMs: 500,
  });
  prober.request("path", "http://board.lan/ops/");
  await sleep(30);
  const svc = core.serviceModel({ unit: "hausnetz.service", url: "http://board.lan/ops/", path: "/ops/" }, "http://board.lan/ops/");
  const derived = core.derive(svc, { truth: "none", status: null, probe: prober.result("path") });
  check("(a) a same-origin 502 without host truth reads as down", derived.s === "down" && derived.l === "bad", derived);
}

// ── (b) static statuses go through the evidence rules ─────────────────────────
{
  const inspr = { wing: "sites", name: "INSPR site", container: "inspr-www", url: "https://www.inspr.at/", port: ":443", status: "external" };
  const model = core.serviceModel(inspr, inspr.url);
  check("(b) a static status opts out of the browser probe", model.probeUrl === null && model.staticState === "external", model);

  for (const [truth, status] of [["live", artifact()], ["stale", null], ["none", null], ["checking", null]]) {
    const derived = core.derive(model, { truth, status, probe: null });
    check(`(b) static status without host evidence (${truth}) claims nothing`,
      derived.l === "off" && derived.word === null && derived.s !== "external", derived);
  }
  const running = core.derive(model, live(artifact({ containers: { "inspr-www": { running: true } } })));
  check("(b) static status with the host's word reads as running, per host", running.s === "running" && running.l === "on" && running.src === "host", running);
  const stopped = core.derive(model, live(artifact({ containers: { "inspr-www": { running: false } } })));
  check("(b) static status cannot mask a stopped container", stopped.s === "stopped" && stopped.l === "bad", stopped);
  const faulted = core.derive(model, live(artifact({ containers: { "inspr-www": { running: true } }, http: { "inspr-www": { code: 503 } } })));
  check("(b) static status cannot mask a host-side HTTP 503", faulted.s === "fault" && faulted.word === "httpStatus", faulted);

  const optOut = core.serviceModel({ name: "x", url: "https://x.example/", probe: false }, "https://x.example/");
  check("(b) probe:false is the same opt-out", optOut.probeUrl === null && core.derive(optOut, live(artifact())).l === "off", optOut);
  const policy = core.serviceModel({ name: "y", url: "https://y.example/", statusPolicy: { source: "hostdash-static", staticState: "protected" } }, "https://y.example/");
  check("(b) statusPolicy.staticState is the same opt-out", policy.probeUrl === null && core.derive(policy, live(artifact())).l === "off", policy);
}

// ── the rest of the truth model, so a refactor cannot quietly loosen it ────────
{
  const passive = core.serviceModel({ container: "mosquitto", passive: true }, null);
  check("stale artifact is not evidence", core.judgeArtifact(artifact({}, 600), Date.now(), 300000).state === "stale", {});
  check("fresh artifact is evidence", core.judgeArtifact(artifact({}, 30), Date.now(), 300000).state === "live", {});
  check("foreign schema is not evidence", core.judgeArtifact({ schema: "other" }, Date.now(), 300000).state === "none", {});
  check("passive card under a stale artifact is dark", core.derive(passive, { truth: "stale", status: artifact({ containers: { mosquitto: { running: true } } }, 600), probe: null }).l === "off", {});
  check("passive card listed as running is lit", core.derive(passive, live(artifact({ containers: { mosquitto: { running: true } } }))).l === "on", {});
  check("passive card the artifact does not list is dark", core.derive(passive, live(artifact())).l === "off", {});

  const babycam = core.serviceModel({ extra: "babycam", passive: true }, null);
  const cam = x => core.derive(babycam, live(artifact({ extras: { babycam: x } })));
  check("babycam muted on purpose is healthy, not a fault", cam({ health: "OK", desired_volume: 0 }).s === "muted" && cam({ health: "OK", desired_volume: 0 }).l === "dim", cam({ health: "OK", desired_volume: 0 }));
  check("babycam audio dead names the failure", cam({ health: "AUDIO_DEAD", desired_volume: 40 }).word === "health_AUDIO_DEAD", cam({ health: "AUDIO_DEAD" }));
  check("babycam unknown health code is still a loud fault", cam({ health: "MIC_GONE" }).l === "bad" && cam({ health: "MIC_GONE" }).word === "healthFault", cam({ health: "MIC_GONE" }));
  check("babycam without telemetry claims nothing", core.derive(babycam, live(artifact())).l === "off", {});

  const web = core.serviceModel({ container: "scrypted", url: "https://hsb1.lan:10443/" }, "https://hsb1.lan:10443/");
  const status = artifact({ containers: { scrypted: { running: true } }, http: { scrypted: { code: 200 } } });
  const away = core.derive(web, { ...live(status), probe: { ok: false, kind: "network" } });
  check("running per host, HTTP 200 on the host, no connection from here", away.l === "split" && away.hostOk === 200, away);
  const noAnswer = core.derive(web, live(artifact({ containers: { scrypted: { running: true } }, http: { scrypted: { code: 0 } } })));
  check("loopback 000 is a fault: no answer", noAnswer.word === "noAnswer" && noAnswer.l === "bad", noAnswer);
  const reach = core.derive(web, { truth: "none", status: null, probe: { ok: true, kind: "ok" } });
  check("browser-only reachability is a ring, not a host claim", reach.l === "ring" && reach.src === "browser", reach);
  const aring = core.derive(web, { truth: "none", status: null, probe: { ok: false, kind: "network" } });
  check("opaque failure without host truth is unreachable, not down", aring.l === "aring" && aring.s === "unreachable", aring);

  const timer = core.serviceModel({ unit: "restic.timer", passive: true }, null);
  const failedJob = core.derive(timer, live(artifact({ units: { "restic.timer": { running: true } }, jobs: { "restic.timer": { ok: false, last: now() - 3600 } } })));
  check("a failed job run is loud", failedJob.s === "jobfail" && failedJob.l === "bad", failedJob);
}

// ── (r1) HOSTD-83 gate round 1 ────────────────────────────────────────────────
{
  // M8 — timestamps that cannot age are not evidence; future beyond clock skew neither.
  const judge = generated => core.judgeArtifact({ schema: "inspr.hostdash.status.v1", generated }, Date.now(), 300000);
  for (const [label, generated] of [["string Infinity", "Infinity"], ["number Infinity", Infinity], ["NaN", NaN],
    ["missing", undefined], ["null", null], ["true", true], ["empty string", ""], ["ISO date", new Date().toISOString()],
    ["zero", 0], ["negative", -5], ["a day ahead", now() + 86400], ["milliseconds", Date.now()]]) {
    const verdict = judge(generated);
    check(`(r1 M8) generated ${label} is not evidence`, verdict.state === "none" && verdict.key === "badTime", verdict);
  }
  const skewed = judge(now() + 60);
  check("(r1 M8) a minute ahead (clock skew) is still live, age 0", skewed.state === "live" && skewed.ageSec === 0, skewed);
  const beyond = judge(now() + 121 + 2);
  check("(r1 M8) beyond the 120 s skew allowance is rejected", beyond.state === "none" && beyond.key === "badTime", beyond);
  const numeric = judge(String(now() - 10));
  check("(r1 M8) a plain decimal string still reads as an epoch", numeric.state === "live" && numeric.ageSec >= 9, numeric);
}

{
  // M7 — empty or malformed telemetry is not health.
  const babycam = core.serviceModel({ extra: "babycam", passive: true }, null);
  for (const [label, x] of [["{}", {}], ["health null", { health: null }], ["health 1", { health: 1 }],
    ["health true", { health: true }], ["health {}", { health: {} }], ["health ''", { health: "" }],
    ["only desired_volume", { desired_volume: 0 }]]) {
    const derived = core.derive(babycam, live(artifact({ extras: { babycam: x } })));
    check(`(r1 M7) telemetry ${label} claims nothing`, derived.l === "off" && derived.word === null && derived.src === "", derived);
  }
  const missing = core.derive(babycam, live(artifact({ extras: {} })));
  check("(r1 M7) missing telemetry claims nothing, and says why", missing.l === "off" && missing.ev.some(e => e.key === "ev_noTelemetry"), missing);
  const bad = core.derive(babycam, live(artifact({ extras: { babycam: { health: null } } })));
  check("(r1 M7) malformed telemetry says so", bad.ev.some(e => e.key === "ev_badTelemetry"), bad);
  const noSection = core.derive(babycam, live({ ...artifact(), extras: null }));
  check("(r1 M7) a null extras section claims nothing", noSection.l === "off" && noSection.word === null, noSection);
  const ok = core.derive(babycam, live(artifact({ extras: { babycam: { health: "OK", desired_volume: 40 } } })));
  check("(r1 M7) an explicit OK is still healthy", ok.l === "on" && ok.word === "listening" && ok.src === "self", ok);
}

{
  // M6 — a self-reporting service with a URL keeps its browser fallback.
  const url = "http://cam.lan:8080/";
  const cam = core.serviceModel({ extra: "cam", url }, url);
  const reached = { ok: true, kind: "ok" };
  for (const [label, ctx] of [["no status file", { truth: "none", status: null }], ["stale status", { truth: "stale", status: null }],
    ["live status without telemetry", live(artifact())], ["live status with empty telemetry", live(artifact({ extras: { cam: {} } }))]]) {
    const derived = core.derive(cam, { ...ctx, probe: reached });
    check(`(r1 M6) extra + URL, ${label}, probe reached: green ring`, derived.l === "ring" && derived.s === "reachable", derived);
  }
  const http = core.derive(cam, { truth: "none", status: null, probe: { ok: false, kind: "http", code: 502 } });
  check("(r1 M6) extra + URL, no status file, same-origin 502: loud", http.l === "bad" && http.vars.code === 502, http);
  const passive = core.serviceModel({ extra: "cam", passive: true }, null);
  for (const [label, ctx] of [["none", { truth: "none", status: null }], ["stale", { truth: "stale", status: null }], ["live without telemetry", live(artifact())]]) {
    check(`(r1 M6) passive extra stays dark (${label})`, core.derive(passive, { ...ctx, probe: reached }).l === "off", {});
  }
  const told = core.derive(cam, { ...live(artifact({ extras: { cam: { health: "VIDEO_STALE" } } })), probe: reached });
  check("(r1 M6) a valid self-report still outranks the probe", told.l === "bad" && told.word === "health_VIDEO_STALE", told);
}

{
  // M3 — job evidence is read on its own; a finished oneshot is not a stopped daemon.
  const backup = core.serviceModel({ unit: "backup.service", passive: true }, null);
  const jobOnlyFail = core.derive(backup, live(artifact({ jobs: { "backup.service": { ok: false, last: now() - 600 } } })));
  check("(r1 M3) a failed job without a unit row is loud", jobOnlyFail.s === "jobfail" && jobOnlyFail.l === "bad", jobOnlyFail);
  const jobOnlyOk = core.derive(backup, live(artifact({ jobs: { "backup.service": { ok: true, last: now() - 600 } } })));
  check("(r1 M3) a good job without a unit row reads 'last run ok'", jobOnlyOk.l === "on" && jobOnlyOk.word === "jobOk", jobOnlyOk);
  const finished = core.derive(backup, live(artifact({ units: { "backup.service": { running: false, active: "inactive" } }, jobs: { "backup.service": { ok: true, last: now() - 600 } } })));
  check("(r1 M3) an inactive oneshot whose last run was ok is not Down", finished.l === "on" && finished.word === "jobOk" && finished.s !== "stopped", finished);
  check("(r1 M3) ... and says it is idle between runs", finished.ev.some(e => e.key === "ev_unitIdle"), finished);
  const failedUnit = core.derive(backup, live(artifact({ units: { "backup.service": { running: false, active: "failed" } }, jobs: { "backup.service": { ok: true } } })));
  check("(r1 M3) a unit in state 'failed' stays loud even with an ok job record", failedUnit.l === "bad", failedUnit);
  const daemon = core.derive(backup, live(artifact({ units: { "backup.service": { running: false, active: "inactive" } } })));
  check("(r1 M3) an inactive unit without a job record is a stopped daemon", daemon.s === "stopped" && daemon.l === "bad", daemon);
  const container = core.serviceModel({ container: "restic", passive: true }, null);
  const stoppedContainer = core.derive(container, live(artifact({ containers: { restic: { running: false } }, jobs: { restic: { ok: true } } })));
  check("(r1 M3) a stopped container is Down even with an ok job record", stoppedContainer.s === "stopped" && stoppedContainer.l === "bad", stoppedContainer);
  const runningFail = core.derive(backup, live(artifact({ units: { "backup.service": { running: true, active: "active" } }, jobs: { "backup.service": { ok: false } } })));
  check("(r1 M3) a failed job under a running unit is loud", runningFail.s === "jobfail", runningFail);
}

{
  // M2 — a readable same-origin failure is handled before the unreachable branch.
  const url = "http://hsb0.lan/ops/";
  const hausnetz = core.serviceModel({ unit: "hausnetz.service", url, sameHost: true, path: "/ops/" }, url);
  const running = artifact({ units: { "hausnetz.service": { running: true, active: "active" } } });
  const at = (status, code, truth = "live") => core.derive(hausnetz, { truth, status, probe: { ok: false, kind: "http", code } });
  const up502 = at(running, 502);
  check("(r1 M2) host running + same-origin 502 is a loud HTTP 502, not Unreachable",
    up502.l === "bad" && up502.word === "httpStatus" && up502.vars.code === 502 && up502.ev.some(e => e.key === "ev_sameOrigin" && e.vars.code === 502), up502);
  const up404 = at(running, 404);
  check("(r1 M2) host running + same-origin 404 is a loud HTTP 404", up404.l === "bad" && up404.vars.code === 404, up404);
  const none502 = at(null, 502, "none");
  check("(r1 M2) no host status + same-origin 502 is Down, code kept", none502.l === "bad" && none502.word === "status_down" && none502.vars.code === 502 && none502.ev.some(e => e.vars?.code === 502), none502);
  const up403 = at(running, 403);
  check("(r1 M2) host running + 403 (LAN-only refusal) is unreachable from here, code kept",
    up403.l === "split" && up403.vars.code === 403 && up403.ev.some(e => e.key === "ev_sameOriginRefused" && e.vars.code === 403), up403);
  const none403 = at(null, 403, "none");
  check("(r1 M2) no host status + 403 is unreachable (amber ring), code kept, not Down", none403.l === "aring" && none403.vars.code === 403, none403);
  const network = core.derive(hausnetz, { ...live(running), probe: { ok: false, kind: "network" } });
  check("(r1 M2) host running + no connection is still the split, route-not-service case", network.l === "split", network);
}

{
  // M1 — the verdict and the lens claim no more than the evidence.
  const ev = l => ({ l, s: l === "off" ? "unknown" : "x" });
  const agg = (ls, truth = "live") => safely(() => core.aggregate(ls.map(ev), truth));
  const allRing = agg(["ring", "ring", "ring"]);
  check("(r1 M1) browser-only reachability is never 'all running'", allRing.v === "partial" && allRing.lens === "ring" && allRing.vouched.length === 0, allRing);
  const nothing = agg(["off", "off"]);
  check("(r1 M1) no evidence at all: dark lens, not green", nothing.v === "partial" && nothing.lens === "off", nothing);
  const mixed = agg(["on", "ring", "off"]);
  check("(r1 M1) some vouched, some not: partial, dimmed green", mixed.v === "partial" && mixed.lens === "dim" && mixed.vouched.length === 1 && mixed.reached.length === 1, mixed);
  const allOn = agg(["on", "dim", "on"]);
  check("(r1 M1) every card host-vouched: ok, solid green", allOn.v === "ok" && allOn.lens === "on", allOn);
  const aringOnly = agg(["on", "aring"]);
  check("(r1 M1) browser-only failure is an amber ring, never the host-confirmed split", aringOnly.v === "notice" && aringOnly.lens === "aring", aringOnly);
  const splitOnly = agg(["on", "split"]);
  check("(r1 M1) host-confirmed unreachable keeps the split lens", splitOnly.v === "notice" && splitOnly.lens === "split", splitOnly);
  const mixedAway = agg(["split", "aring"]);
  check("(r1 M1) mixed unreachable: the unconfirmed one decides (amber ring)", mixedAway.lens === "aring", mixedAway);
  const failing = agg(["on", "bad", "ring"]);
  check("(r1 M1) a failure is a failure", failing.v === "bad" && failing.lens === "bad", failing);
  const stale = agg(["ring", "ring"], "stale");
  check("(r1 M1) without live host truth the lens stays dark", stale.v === "quiet" && stale.lens === "off", stale);

  // End to end: a fresh artifact that lists none of the services, every probe reached.
  const svcs = ["a", "b"].map(name => core.serviceModel({ container: name, url: `http://${name}.lan/` }, `http://${name}.lan/`));
  const evs = svcs.map(svc => core.derive(svc, { ...live(artifact()), probe: { ok: true, kind: "ok" } }));
  const unmatched = safely(() => core.aggregate(evs, "live"));
  check("(r1 M1) fresh artifact listing none of the services + every probe reached: not ok", unmatched.v === "partial" && unmatched.lens === "ring", { unmatched, evs });
}

{
  // M5 — same-host services resolve without a redundant `url`.
  const resolve = (raw, page) => safely(() => core.resolveTarget(raw, page));
  check("(r1 M5) sameHost + path, no url, resolves on the dashboard origin",
    resolve({ sameHost: true, path: "/ops/" }, "http://hsb0.lan/index.html") === "http://hsb0.lan/ops/", resolve({ sameHost: true, path: "/ops/" }, "http://hsb0.lan/index.html"));
  check("(r1 M5) a path-only service keeps the dashboard's port",
    resolve({ sameHost: true, path: "/fernsehen/" }, "http://127.0.0.1:5555/index.html") === "http://127.0.0.1:5555/fernsehen/", {});
  check("(r1 M5) sameHost + port, no url, swaps the port",
    resolve({ sameHost: true, port: ":3000" }, "http://192.168.1.99:8080/") === "http://192.168.1.99:3000/", resolve({ sameHost: true, port: ":3000" }, "http://192.168.1.99:8080/"));
  check("(r1 M5) sameHost keeps resolving with a canonical url present",
    resolve({ sameHost: true, url: "http://hsb1.lan:32400/web", port: ":32400", path: "/web" }, "http://10.0.0.5/") === "http://10.0.0.5:32400/web", {});
  check("(r1 M5) sameHost + https scheme + port",
    resolve({ sameHost: true, scheme: "https:", port: ":10443" }, "http://hsb1.lan/") === "https://hsb1.lan:10443/", resolve({ sameHost: true, scheme: "https:", port: ":10443" }, "http://hsb1.lan/"));
  check("(r1 M5) a passive service has no target", resolve({ sameHost: true, path: "/x/", passive: true }, "http://h.lan/") === null, {});
  check("(r1 M5) a plain url is used as is", resolve({ url: "https://x.example/" }, "http://h.lan/") === "https://x.example/", {});
  check("(r1 M5) no url and not same-host: no target", resolve({ name: "x" }, "http://h.lan/") === null, {});
  check("(r1 M5) under file:// a same-host service falls back to its url, or none",
    resolve({ sameHost: true, url: "http://h.lan/a/", path: "/a/" }, "file:///tmp/index.html") === "http://h.lan/a/" &&
    resolve({ sameHost: true, path: "/a/" }, "file:///tmp/index.html") === null, {});
}

if (failures.length) {
  console.error(`test-evidence: ${failures.length} of ${failures.length + results.length} checks FAILED\n${failures.map(line => `  ✗ ${line}`).join("\n")}`);
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, checks: results.length, results }, null, 2));
