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
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import vm from "node:vm";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const html = await readFile(join(repoRoot, "public", "index.html"), "utf8");
const block = html.match(/\/\/ <evidence-core>\n([\s\S]*?)\/\/ <\/evidence-core>/);
if (!block) throw new Error("Evidence core markers not found in public/index.html");
const core = vm.runInNewContext(`${block[1]}\nEvidenceCore`, {
  setTimeout, clearTimeout, Promise, Map, Set, Number, String, Math, Boolean, Array, Object,
});

const results = [];
const check = (name, condition, detail) => {
  if (!condition) throw new Error(`${name}: ${JSON.stringify(detail)}`);
  results.push(name);
};
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
  // re-requesting everything. The tail of the queue must not starve either.
  const seen = new Set();
  const prober = core.createProber({
    fetchImpl: async url => { seen.add(url); await sleep(30); return { type: "opaque" }; },
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

console.log(JSON.stringify({ ok: true, checks: results.length, results }, null, 2));
