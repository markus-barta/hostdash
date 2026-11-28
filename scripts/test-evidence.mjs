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
//   (r2) the HOSTD-83 gate round 2 findings: only an identified oneshot service is a
//       finished job (timers, sockets, daemons stay Down); a job whose last run was ok
//       is counted apart from running; malformed host records are no evidence and never
//       throw; "opens" needs this browser's own reachability evidence.
//
// Every check runs; failures are listed together and the exit code is 1.
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import vm from "node:vm";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
// HOSTDASH_INDEX runs the checks against another copy of the page (e.g. the previous
// commit's), which is how the PR shows each new check failing before its fix.
const html = await readFile(process.env.HOSTDASH_INDEX || join(repoRoot, "public", "index.html"), "utf8");
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

// HOSTD-85: a container-backed probe opt-out still reports host failures.
{
  const url = "https://hsb1.lan:10443/";
  const config = vm.runInNewContext(`${await readFile(join(repoRoot, "hosts/hsb1/config.js"), "utf8")}\nwindow.HOSTDASH_CONFIG`, { window: {} });
  const service = config.services.find(service => service.name === "Scrypted");
  const target = core.resolveTarget(service, "http://hsb1.lan/");
  const model = core.serviceModel(service, target);
  check("(HOSTD-85) Scrypted keeps its HTTPS link and certificate warning",
    target === url && service.certIssue === true && service.note === "service answers with a self-signed localhost certificate", service);
  check("(HOSTD-85) host-only Scrypted has no browser probe", service.probe === false && model.probeUrl === null, model);
  for (const [running, code, state, led, word] of [
    [true, 200, "running", "on", "status_running"],
    [true, 302, "running", "on", "status_running"],
    [false, 302, "stopped", "bad", "status_stopped"],
    [true, 503, "fault", "bad", "httpStatus"],
    [true, 0, "fault", "bad", "noAnswer"],
  ]) {
    const derived = core.derive(model, live(artifact({
      containers: { scrypted: { running } }, http: { scrypted: { code } },
    })));
    check(`(HOSTD-85) probe:false, container running=${running}, host HTTP ${code}: ${state}`,
      derived.s === state && derived.l === led && derived.word === word && derived.src === "host", derived);
  }
}

// HOSTD-86: pixdcon v2 keeps the existing HTTP probe key, but needs its own container row.
{
  const config = vm.runInNewContext(`${await readFile(join(repoRoot, "hosts/hsb1/config.js"), "utf8")}\nwindow.HOSTDASH_CONFIG`, { window: {} });
  const service = config.services.find(service => service.name === "pixdcon");
  const model = core.serviceModel(service, core.resolveTarget(service, "http://hsb1.lan/"));
  for (const [running, code, state, led, word] of [
    [true, 200, "running", "on", "status_running"],
    [false, 200, "stopped", "bad", "status_stopped"],
    [true, 503, "fault", "bad", "httpStatus"],
  ]) {
    const derived = core.derive(model, live(artifact({
      containers: { "pixdcon2-edge": { running } }, http: { pixdcon: { code } },
    })));
    check(`(HOSTD-86) pixdcon2-edge running=${running}, host HTTP ${code}: ${state}`,
      derived.s === state && derived.l === led && derived.word === word && derived.src === "host"
        && (state !== "fault" || derived.vars.code === code), derived);
  }
  const oldOnly = core.derive(model, live(artifact({
    containers: { pixdcon: { running: true } }, http: { pixdcon: { code: 200 } },
  })));
  check("(HOSTD-86) the old pixdcon container row cannot vouch for v2",
    oldOnly.l === "off" && oldOnly.src === "" && !core.runsPerHost(oldOnly), oldOnly);
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
  // r2: "finished" needs the host to identify the unit as a oneshot (systemd Type=).
  const finished = core.derive(backup, live(artifact({ units: { "backup.service": { running: false, active: "inactive", type: "oneshot" } }, jobs: { "backup.service": { ok: true, last: now() - 600 } } })));
  check("(r1 M3) an inactive oneshot whose last run was ok is not Down", finished.l === "on" && finished.word === "jobOk" && finished.s !== "stopped", finished);
  check("(r1 M3) ... and says it is idle between runs", finished.ev.some(e => e.key === "ev_unitIdle"), finished);
  const failedUnit = core.derive(backup, live(artifact({ units: { "backup.service": { running: false, active: "failed", type: "oneshot" } }, jobs: { "backup.service": { ok: true } } })));
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

// ── (r2) HOSTD-83 gate round 2 ────────────────────────────────────────────────
{
  // M1 — a completed job is only an identified oneshot SERVICE. Timers, sockets and
  // daemons that are inactive stay Down, whatever their last run said.
  const ok = { ok: true, last: now() - 600 };
  const inactive = (unit, row) => {
    const svc = core.serviceModel({ unit, passive: true }, null);
    return core.derive(svc, live(artifact({ units: { [unit]: { running: false, active: "inactive", ...row } }, jobs: { [unit]: ok } })));
  };
  for (const [label, unit, row] of [
    ["a disabled .timer", "compose-hsb9-update.timer", {}],
    ["a stopped .socket", "fleet-heartbeat.socket", {}],
    ["a .service the host does not identify", "ir-bridge.service", {}],
    ["a .service of Type=simple (a daemon)", "ir-bridge.service", { type: "simple" }],
    ["a .timer the artifact calls a oneshot", "restic.timer", { type: "oneshot" }],
  ]) {
    const derived = inactive(unit, row);
    check(`(r2 M1) ${label}, inactive with an ok last run, is Down`, derived.s === "stopped" && derived.l === "bad" && derived.word === "status_stopped", derived);
  }
  const oneshot = inactive("backup.service", { type: "oneshot" });
  check("(r2 M1) an identified oneshot service, inactive with an ok last run, is a finished job", oneshot.s === "jobok" && oneshot.l === "on" && oneshot.word === "jobOk" && oneshot.ev.some(e => e.key === "ev_unitIdle"), oneshot);
  const failedOneshot = core.derive(core.serviceModel({ unit: "backup.service", passive: true }, null),
    live(artifact({ units: { "backup.service": { running: false, active: "failed", type: "oneshot" } }, jobs: { "backup.service": ok } })));
  check("(r2 M1) an identified oneshot in state failed stays loud", failedOneshot.l === "bad", failedOneshot);
  const activeTimer = core.derive(core.serviceModel({ unit: "restic.timer", passive: true }, null),
    live(artifact({ units: { "restic.timer": { running: true, active: "active" } }, jobs: { "restic.timer": ok } })));
  check("(r2 M1) an active timer with an ok last run is running (and says the last run)", activeTimer.s === "running" && activeTimer.word === "jobOk" && activeTimer.ev.some(e => e.key === "ev_unitRunning"), activeTimer);
}

{
  // M2 — a job whose last run was ok is vouched for, but not running: the aggregate
  // counts it apart, so the hero cannot say "The service is running" for it.
  const backup = core.serviceModel({ unit: "backup.service", passive: true }, null);
  const finished = core.derive(backup, live(artifact({ units: { "backup.service": { running: false, active: "inactive", type: "oneshot" } }, jobs: { "backup.service": { ok: true, last: now() - 600 } } })));
  const alone = safely(() => core.aggregate([finished], "live"));
  check("(r2 M2) one finished oneshot: ok, but zero running and one job", alone.v === "ok" && alone.running?.length === 0 && alone.jobs?.length === 1, alone);
  const jobOnly = core.derive(backup, live(artifact({ jobs: { "backup.service": { ok: true, last: now() - 600 } } })));
  check("(r2 M2) a job record without a unit row is a job, not a running service", jobOnly.s === "jobok" && jobOnly.l === "on", jobOnly);
  const daemon = core.derive(core.serviceModel({ container: "mosquitto", passive: true }, null), live(artifact({ containers: { mosquitto: { running: true } } })));
  const mixed = safely(() => core.aggregate([daemon, finished, jobOnly], "live"));
  check("(r2 M2) running and jobs are counted apart", mixed.v === "ok" && mixed.lens === "on" && mixed.running?.length === 1 && mixed.jobs?.length === 2 && mixed.vouched.length === 3, mixed);
  const partial = safely(() => core.aggregate([daemon, finished, { l: "off", s: "unknown" }], "live"));
  check("(r2 M2) partial: the running count excludes the job", partial.v === "partial" && partial.running?.length === 1 && partial.jobs?.length === 1, partial);
  // A job record never vouches for a route: unreachable without a running row is the
  // amber ring, never the host-confirmed split ("running per host").
  const web = core.serviceModel({ unit: "backup.service", url: "http://b.lan/" }, "http://b.lan/");
  const away = core.derive(web, { ...live(artifact({ jobs: { "backup.service": { ok: true } } })), probe: { ok: false, kind: "network" } });
  check("(r2 M2) job record + no connection is the amber ring, not 'running per host'", away.l === "aring" && away.src === "browser" && !away.ev.some(e => e.key === "ev_noHost"), away);
  const refused = core.derive(web, { ...live(artifact({ jobs: { "backup.service": { ok: true } } })), probe: { ok: false, kind: "http", code: 403 } });
  check("(r2 M2) job record + 403 is the amber ring too", refused.l === "aring" && refused.vars.code === 403, refused);
}

{
  // M4 — malformed host records are no evidence, never a verdict, and never throw.
  const container = core.serviceModel({ container: "plex", passive: true }, null);
  const unit = core.serviceModel({ unit: "adguardhome.service", passive: true }, null);
  for (const [label, record] of [["{}", {}], ["running null", { running: null }], ["running 'true'", { running: "true" }],
    ["running 1", { running: 1 }], ["running {}", { running: {} }], ["null", null], ["a string", "running"], ["an array", [true]]]) {
    const c = core.derive(container, live(artifact({ containers: { plex: record } })));
    check(`(r2 M4) container record ${label} claims nothing`, c.l === "off" && c.word === null && c.s !== "stopped", c);
    const u = core.derive(unit, live(artifact({ units: { "adguardhome.service": record } })));
    check(`(r2 M4) unit record ${label} claims nothing`, u.l === "off" && u.word === null && u.s !== "stopped", u);
  }
  const why = core.derive(container, live(artifact({ containers: { plex: {} } })));
  check("(r2 M4) a malformed record says so", why.ev.some(e => e.key === "ev_badRecord"), why);
  check("(r2 M4) an explicit running:false is still Down", core.derive(container, live(artifact({ containers: { plex: { running: false } } }))).s === "stopped", {});

  const hostile = JSON.parse('{"toString":null}');
  const codes = [["null", null], ["empty string", ""], ["{}", {}], ["hostile toString", hostile], ["2.5", 2.5], ["999", 999],
    ["-1", -1], ["'abc'", "abc"], ["true", true], ["NaN", NaN], ["Infinity", Infinity], ["'1e3'", "1e3"], ["missing", undefined]];
  const web = core.serviceModel({ container: "plex", passive: true }, null);
  for (const [label, code] of codes) {
    const derived = safely(() => core.derive(web, live(artifact({ containers: { plex: { running: true } }, http: { plex: { code } } }))));
    check(`(r2 M4) http code ${label} is no evidence: the running row decides`, derived.s === "running" && derived.l === "on" && derived.word === "status_running", derived);
  }
  const codeless = safely(() => core.derive(web, live(artifact({ http: { plex: { code: null } } }))));
  check("(r2 M4) code null without a row is not 'No answer'", codeless.l === "off" && codeless.word === null, codeless);
  for (const [label, code, want] of [["number 0", 0, "noAnswer"], ["curl '000'", "000", "noAnswer"], ["'502'", "502", "httpStatus"], ["503", 503, "httpStatus"]]) {
    const derived = core.derive(web, live(artifact({ containers: { plex: { running: true } }, http: { plex: { code } } })));
    check(`(r2 M4) a valid code ${label} still counts`, derived.l === "bad" && derived.word === want, derived);
  }
  check("(r2 M4) codeOf never converts an object", safely(() => core.codeOf(hostile)) === null && core.codeOf(200) === 200 && core.codeOf("000") === 0, {});

  for (const [label, job] of [["{}", {}], ["ok 'true'", { ok: "true" }], ["ok 1", { ok: 1 }], ["null", null]]) {
    const derived = core.derive(core.serviceModel({ unit: "backup.service", passive: true }, null), live(artifact({ jobs: { "backup.service": job } })));
    check(`(r2 M4) job record ${label} claims nothing`, derived.l === "off" && derived.word === null, derived);
  }
  const future = core.derive(core.serviceModel({ unit: "backup.service", passive: true }, null), live(artifact({ jobs: { "backup.service": { ok: false, last: 1e20 } } })));
  check("(r2 M4) a job dated after the artifact counts undated (no 'Invalid Date')", future.s === "jobfail" && future.ev[0].vars.last === null, future);
  const inherited = core.derive(core.serviceModel({ container: "constructor", passive: true }, null), live(artifact()));
  check("(r2 M4) a service named like an inherited property finds no record", inherited.l === "off" && inherited.word === null, inherited);

  // One hostile record cannot stop the next card's update: every card is derived.
  const svcs = [core.serviceModel({ container: "a", passive: true }, null), core.serviceModel({ container: "b", passive: true }, null)];
  const status = artifact({ containers: { a: { running: true }, b: { running: false } }, http: { a: { code: hostile } } });
  const derived = safely(() => svcs.map(svc => core.derive(svc, live(status))));
  check("(r2 M4) a hostile code on one card never throws, and the next card still updates",
    Array.isArray(derived) && derived[0].s === "running" && derived[1].s === "stopped", derived);
  // Every operation on this object throws (its handler answers every trap with a thrower).
  const trap = new Proxy({}, new Proxy({}, { get: () => () => { throw new Error("hostile record"); } }));
  const trapped = safely(() => core.derive(svcs[0], { truth: "live", status: { ...artifact(), containers: trap } }));
  check("(r2 M4) derive degrades to no evidence instead of throwing", trapped.l === "off" && trapped.word === null && trapped.ev?.some(e => e.key === "ev_badRecord"), trapped);
}

{
  // M5 — "opens"/"works" needs reachability evidence from this browser.
  const url = "http://ha.lan:8123/";
  const ha = core.serviceModel({ container: "homeassistant", url }, url);
  const running = artifact({ containers: { homeassistant: { running: true } } });
  const opens = ev => safely(() => core.opens(ev));
  const runs = ev => safely(() => core.runsPerHost(ev));
  const pending = core.derive(ha, live(running));
  check("(r2 M5) running per host, probe pending: not 'opens', host-running", pending.l === "on" && opens(pending) === false && runs(pending) === true, pending);
  const disabled = core.derive(core.serviceModel({ container: "homeassistant", url, probe: false }, url), live(running));
  check("(r2 M5) running per host, probe disabled: not 'opens', host-running", disabled.l === "on" && opens(disabled) === false && runs(disabled) === true, disabled);
  const both = core.derive(ha, { ...live(running), probe: { ok: true, kind: "ok" } });
  check("(r2 M5) running per host and reached from here: opens", opens(both) === true && runs(both) === false, both);
  const ring = core.derive(ha, { truth: "none", status: null, probe: { ok: true, kind: "ok" } });
  check("(r2 M5) reached from here without host status: opens, not host-running", opens(ring) === true && runs(ring) === false, ring);
  const away = core.derive(ha, { ...live(running), probe: { ok: false, kind: "network" } });
  check("(r2 M5) running per host but unreachable: neither", opens(away) === false && runs(away) === false, away);
  const job = core.derive(core.serviceModel({ unit: "backup.service", passive: true }, null), live(artifact({ jobs: { "backup.service": { ok: true } } })));
  check("(r2 M5) a job-only card neither opens nor runs", opens(job) === false && runs(job) === false, job);
}

{
  // Same kinds, found in the round-2 sweep: a non-web URL is neither a link nor a probe,
  // and a stopped unit names only the state the host reported.
  const resolve = (raw, page) => safely(() => core.resolveTarget(raw, page));
  for (const url of ["javascript:alert(1)", "data:text/html,<b>x</b>", "file:///etc/passwd", "http://[broken"]) {
    check(`(r2 sweep) url ${url} is no target`, resolve({ url }, "http://h.lan/") === null, resolve({ url }, "http://h.lan/"));
  }
  check("(r2 sweep) an https url is still a target", resolve({ url: "https://x.example/a" }, "http://h.lan/") === "https://x.example/a", {});
  check("(r2 sweep) a relative url resolves on the page", resolve({ url: "./ops/" }, "http://h.lan/index.html") === "http://h.lan/ops/", resolve({ url: "./ops/" }, "http://h.lan/index.html"));
  const unit = core.serviceModel({ unit: "x.service", passive: true }, null);
  const bare = core.derive(unit, live(artifact({ units: { "x.service": { running: false } } })));
  check("(r2 sweep) a stopped unit without an active state invents none", bare.s === "stopped" && bare.ev[0].key === "ev_unitNotActive" && !bare.ev[0].vars.active, bare);
  const named = core.derive(unit, live(artifact({ units: { "x.service": { running: false, active: "failed" } } })));
  check("(r2 sweep) a stopped unit keeps the state the host named", named.ev[0].key === "ev_unitStopped" && named.ev[0].vars.active === "failed", named);
}

// ── (r3) HOSTD-83 gate round 3 ────────────────────────────────────────────────
{
  // M3 — a same-host `scheme` is read the way the pre-rewrite board's (7e4896d) URL
  // setter read it: any case, with or without the colon. Only http and https switch it.
  const resolve = (raw, page) => safely(() => core.resolveTarget(raw, page));
  const scrypted = scheme => ({ sameHost: true, scheme, port: ":10443" });
  for (const scheme of ["https", "HTTPS:", "https:", "HTTPS", "Https:", "https://", " https "]) {
    const got = resolve(scrypted(scheme), "http://hsb1.lan/");
    check(`(r3 M3) scheme ${JSON.stringify(scheme)} + port on an http dashboard is https`, got === "https://hsb1.lan:10443/", got);
  }
  for (const scheme of ["http", "HTTP:", "http:"]) {
    const got = resolve(scrypted(scheme), "https://hsb1.lan/");
    check(`(r3 M3) scheme ${JSON.stringify(scheme)} on an https dashboard is http`, got === "http://hsb1.lan:10443/", got);
  }
  for (const scheme of ["ftp", "javascript:", "data:", "", "htt ps", "httpss", null, 42, {}]) {
    const got = resolve(scrypted(scheme), "http://hsb1.lan/");
    check(`(r3 M3) scheme ${JSON.stringify(scheme)} keeps the page's own scheme`, got === "http://hsb1.lan:10443/", got);
  }
  const path = resolve({ sameHost: true, scheme: "HTTPS", path: "/fernsehen/" }, "http://hsb9.lan/index.html");
  check("(r3 M3) scheme without colon on a path-only service", path === "https://hsb9.lan/fernsehen/", path);
  check("(r3 M3) schemeOf normalizes case and colon only", safely(() => core.schemeOf("HTTPS")) === "https:" &&
    core.schemeOf("http:") === "http:" && core.schemeOf("wss") === null && core.schemeOf(undefined) === null, {});
}

if (failures.length) {
  console.error(`test-evidence: ${failures.length} of ${failures.length + results.length} checks FAILED\n${failures.map(line => `  ✗ ${line}`).join("\n")}`);
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, checks: results.length, results }, null, 2));
