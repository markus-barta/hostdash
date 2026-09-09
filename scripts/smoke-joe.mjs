#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const joePageSource = await readFile(join(repoRoot, "public", "joe", "index.html"), "utf8");
const browserPath = process.env.BROWSER_PATH || "/usr/bin/google-chrome";

function extractIsCanonicalJoeHost(source) {
  const start = source.indexOf("function isCanonicalJoeHost(");
  const end = source.indexOf("\n  var host = location.hostname.toLowerCase();", start);
  if (start < 0 || end < 0) throw new Error("isCanonicalJoeHost missing from public/joe/index.html");
  const fnSource = source.slice(start, end).trim();
  return new Function(`${fnSource}\nreturn isCanonicalJoeHost;`)();
}

function assertJoeHostGate(isCanonicalJoeHost) {
  const allow = [
    "hsb1.lan", "hsb1", "localhost", "127.0.0.1", "::1",
    "HSB1.LAN", "[::1]",
    "100.64.0.7", "100.64.0.0", "100.127.255.255",
    "hsb1.tail1234.ts.net", "foo.hsb1.ts.net", "hsb1.ts.net"
  ];
  const deny = [
    "cs0.barta.cm", "example.com", "8.8.8.8",
    "100.63.255.255", "100.128.0.1", "100.64.0.256", "100.64.0.07",
    "192.168.1.10", "10.0.0.1",
    "example.ts.net", "hsb1.example.com"
  ];
  for (const host of allow) {
    if (!isCanonicalJoeHost(host)) throw new Error(`expected canonical Joe host: ${host}`);
  }
  for (const host of deny) {
    if (isCanonicalJoeHost(host)) throw new Error(`expected gated Joe host: ${host}`);
  }
}

assertJoeHostGate(extractIsCanonicalJoeHost(joePageSource));
const site = await mkdtemp(join(tmpdir(), "hostdash-joe-site-"));
const profile = await mkdtemp(join(tmpdir(), "hostdash-joe-browser-"));
const requests = [];

await cp(join(repoRoot, "public"), site, { recursive: true });
const sample = JSON.parse(await readFile(join(repoRoot, "docs/examples/joe-data.sample.json"), "utf8"));

async function writeSnapshot(overrides = {}) {
  const snapshot = structuredClone(sample);
  snapshot.generatedAt = new Date().toISOString();
  if (overrides.generatedAt) snapshot.generatedAt = overrides.generatedAt;
  if (overrides.halt !== undefined) snapshot.safety.halt = overrides.halt;
  if (overrides.haltReason !== undefined) snapshot.safety.haltReason = overrides.haltReason;
  if (overrides.gatewayStatus) snapshot.safety.gateway.status = overrides.gatewayStatus;
  if (overrides.gatewayDetail !== undefined) snapshot.safety.gateway.detail = overrides.gatewayDetail;
  await writeFile(join(site, "joe", "data.json"), JSON.stringify(snapshot));
}

await writeSnapshot();

function historyPoint(iso, equity) {
  return {
    t: iso,
    desks: {
      j: { equity: 5000, dayPnl: 0, totalPnl: 0 },
      joe: { equity: 5000, dayPnl: 0, totalPnl: 0 },
      joel: { equity: 9000, dayPnl: 0, totalPnl: 0 }
    },
    totals: { equity, dayPnl: 12.5, totalPnl: equity - 19000 }
  };
}

async function writeSparseHistory(hours = 9, stepMinutes = 30) {
  const end = Date.now();
  const step = stepMinutes * 60_000;
  const start = end - hours * 3600_000;
  const points = [];
  for (let t = start; t <= end; t += step) {
    points.push(historyPoint(new Date(t).toISOString(), 19000 + (t - start) / 3600_000));
  }
  await writeFile(join(site, "joe", "history.json"), JSON.stringify({
    schema: "inspr.joe.household.history.v1",
    points
  }));
}

await writeSparseHistory();

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", "http://local.test");
  requests.push({ host: request.headers.host || "", path: url.pathname });
  const relative = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
  if (relative.includes("..")) {
    response.writeHead(400);
    response.end("bad request");
    return;
  }
  try {
    const file = await readFile(join(site, relative.endsWith("/") ? relative + "index.html" : relative));
    const type = relative.endsWith(".json") ? "application/json" : "text/html; charset=utf-8";
    response.writeHead(200, { "content-type": type, "cache-control": "no-store" });
    response.end(file);
  } catch {
    response.writeHead(404);
    response.end("not found");
  }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const sitePort = server.address().port;

async function freePort() {
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}

const cdpPort = await freePort();
const browser = spawn(browserPath, [
  "--headless=new",
  "--disable-gpu",
  "--no-sandbox",
  "--no-proxy-server",
  "--host-resolver-rules=MAP hsb1.lan 127.0.0.1, MAP cs0.barta.cm 127.0.0.1",
  `--remote-debugging-port=${cdpPort}`,
  `--user-data-dir=${profile}`,
  "about:blank",
]);
browser.stdout.resume();
browser.stderr.resume();

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function waitForJson(path) {
  const url = `http://127.0.0.1:${cdpPort}${path}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch {
      // Browser not ready yet.
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function cleanup() {
  browser.kill("SIGTERM");
  await delay(150);
  await new Promise(resolve => server.close(resolve));
  await rm(site, { recursive: true, force: true });
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

try {
  const pages = await waitForJson("/json/list");
  const page = pages.find(candidate => candidate.type === "page");
  if (!page) throw new Error("No browser page target found");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(resolve => { ws.onopen = resolve; });
  let nextId = 0;
  const pending = new Map();
  const exceptions = [];
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params.exceptionDetails.text || "runtime exception");
    if (message.id && pending.has(message.id)) {
      const promise = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) promise.reject(new Error(JSON.stringify(message.error)));
      else promise.resolve(message.result);
    }
  };

  function send(method, params = {}) {
    const id = ++nextId;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  }
  async function value(expression) {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "evaluation failed");
    return result.result.value;
  }
  async function navigate(url, readyExpression) {
    await send("Page.navigate", { url });
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (await value(`Boolean(${readyExpression})`).catch(() => false)) return;
      await delay(100);
    }
    throw new Error(`Page did not become ready: ${url}`);
  }

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  const hsb1Url = `http://hsb1.lan:${sitePort}/joe/`;
  await navigate(hsb1Url, "document.documentElement.dataset.joeState");
  const healthy = await value(`(() => ({
    view: document.documentElement.dataset.joeView,
    state: document.documentElement.dataset.joeState,
    deskIds: [...document.querySelectorAll('#desks .desk')].map(node => node.dataset.desk),
    states: [...document.querySelectorAll('.state')].map(node => node.textContent),
    total: document.getElementById('totalEquity')?.textContent,
    gateway: document.getElementById('gatewayValue')?.textContent,
    halt: document.getElementById('haltValue')?.textContent,
    alarmHidden: document.getElementById('alarm')?.hidden,
    columns: getComputedStyle(document.getElementById('desks')).gridTemplateColumns.split(' ').length,
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  }))()`);
  if (
    healthy.view !== "board" || healthy.state !== "ok" ||
    JSON.stringify(healthy.deskIds) !== JSON.stringify(["j", "joe", "joel"]) ||
    !healthy.states.includes("Working") || !healthy.states.includes("Sitting out") ||
    !/30[\.\s]000/.test(healthy.total || "") || healthy.gateway !== "OK · connected" ||
    !healthy.halt.startsWith("Off") || !healthy.alarmHidden || healthy.columns !== 3 || healthy.overflow
  ) throw new Error(`Healthy board mismatch: ${JSON.stringify(healthy)}`);
  if (process.env.JOE_SCREENSHOT_DIR) {
    const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
    await writeFile(join(process.env.JOE_SCREENSHOT_DIR, "joe-dash-desktop.png"), Buffer.from(shot.data, "base64"));
  }

  async function waitForHistoryChart() {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (await value("Boolean(typeof Chart !== 'undefined' && Chart.getChart('historyChart'))").catch(() => false)) return;
      await delay(100);
    }
    throw new Error("History chart did not appear");
  }
  async function historyScale(range) {
    return value(`(() => {
      const btn = document.querySelector('.history-controls button[data-range="${range}"]');
      if (!btn) return { error: "missing range button ${range}" };
      btn.click();
      const chart = Chart.getChart("historyChart");
      if (!chart) return { error: "no chart after ${range}" };
      const x = chart.scales.x;
      const data = chart.data.datasets[0].data;
      return {
        type: x.type,
        min: x.min,
        max: x.max,
        span: x.max - x.min,
        firstX: data[0] && data[0].x,
        lastX: data[data.length - 1] && data[data.length - 1].x,
        pointCount: data.length,
        period: document.getElementById("histDeltaPeriod")?.textContent
      };
    })()`);
  }
  await waitForHistoryChart();
  const day = await historyScale("1d");
  const week = await historyScale("1w");
  const month = await historyScale("1m");
  const all = await historyScale("all");
  const DAY = 864e5;
  const near = (actual, expected, slack) => Math.abs(actual - expected) <= slack;
  if (day.error || week.error || month.error || all.error) {
    throw new Error(`History range click failed: ${JSON.stringify({ day, week, month, all })}`);
  }
  if (day.type !== "time" || week.type !== "time" || all.type !== "time") {
    throw new Error(`History x scale is not time: ${JSON.stringify({ day, week, all })}`);
  }
  if (!near(day.span, DAY, 2000) || !near(week.span, 7 * DAY, 2000) || !near(month.span, 30 * DAY, 2000)) {
    throw new Error(`History windows are not 1d/7d/30d: ${JSON.stringify({ day, week, month })}`);
  }
  if (!(all.span < day.span && day.span < week.span && week.span < month.span)) {
    throw new Error(`History windows do not zoom: ${JSON.stringify({ all, day, week, month })}`);
  }
  if (!(day.min < day.firstX && week.min < day.min && month.min < week.min)) {
    throw new Error(`Sparse history is not right-aligned in longer windows: ${JSON.stringify({ day, week, month })}`);
  }
  if (!near(all.min, all.firstX, 2000) || !near(all.max, all.lastX, 2000)) {
    throw new Error(`ALL should span first…last point: ${JSON.stringify(all)}`);
  }
  if (day.pointCount !== week.pointCount || week.pointCount !== all.pointCount) {
    throw new Error(`Sparse 9h series should keep the same points across ranges: ${JSON.stringify({ day, week, all })}`);
  }

  const expand = await value(`(() => {
    document.getElementById("historyExpandBtn").click();
    return {
      expanded: document.getElementById("historyBoard")?.classList.contains("is-expanded"),
      chart: Boolean(Chart.getChart("historyChart"))
    };
  })()`);
  if (!expand.expanded || !expand.chart) throw new Error(`History expand mismatch: ${JSON.stringify(expand)}`);
  await value(`document.getElementById("historyCloseBtn").click()`);

  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  const mobile = await value(`(() => ({
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    columns: getComputedStyle(document.getElementById('desks')).gridTemplateColumns.split(' ').length,
    gateHidden: document.getElementById('privateGate').hidden,
  }))()`);
  if (mobile.overflow || mobile.columns !== 1 || !mobile.gateHidden) throw new Error(`Mobile layout mismatch: ${JSON.stringify(mobile)}`);
  if (process.env.JOE_SCREENSHOT_DIR) {
    const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
    await writeFile(join(process.env.JOE_SCREENSHOT_DIR, "joe-dash-mobile.png"), Buffer.from(shot.data, "base64"));
  }
  await send("Emulation.clearDeviceMetricsOverride");

  await writeSnapshot({ generatedAt: new Date(Date.now() - 3600_000).toISOString() });
  await navigate(`${hsb1Url}?stale=1`, "document.documentElement.dataset.joeState");
  const stale = await value(`({ state: document.documentElement.dataset.joeState, freshness: document.getElementById('freshValue')?.textContent, alarm: document.getElementById('alarmText')?.textContent })`);
  if (stale.state !== "attention" || !stale.freshness.startsWith("STALE") || !/stale/i.test(stale.alarm || "")) throw new Error(`Stale state mismatch: ${JSON.stringify(stale)}`);

  await writeSnapshot({ halt: true, haltReason: "Operator check", gatewayStatus: "down", gatewayDetail: "No heartbeat" });
  await navigate(`${hsb1Url}?broken=1`, "document.documentElement.dataset.joeState");
  const broken = await value(`({ state: document.documentElement.dataset.joeState, alarm: document.getElementById('alarmText')?.textContent })`);
  if (broken.state !== "attention" || !/HALT is on/.test(broken.alarm || "") || !/Gateway is down/.test(broken.alarm || "")) throw new Error(`Broken state mismatch: ${JSON.stringify(broken)}`);

  const cs0Before = requests.filter(item => item.host.startsWith("cs0.barta.cm") && item.path === "/joe/data.json").length;
  const cs0Url = `http://cs0.barta.cm:${sitePort}/joe/`;
  await navigate(cs0Url, "document.documentElement.dataset.joeView === 'stub'");
  await delay(250);
  const stub = await value(`({ view: document.documentElement.dataset.joeView, gateHidden: document.getElementById('privateGate')?.hidden, dashboardHidden: document.getElementById('dashboard')?.hidden, text: document.body.innerText })`);
  const cs0After = requests.filter(item => item.host.startsWith("cs0.barta.cm") && item.path === "/joe/data.json").length;
  if (stub.view !== "stub" || stub.gateHidden || !stub.dashboardHidden || !/Joe lives at home/.test(stub.text) || !/Tailscale/.test(stub.text) || cs0After !== cs0Before) throw new Error(`cs0 privacy stub mismatch: ${JSON.stringify({ stub, cs0Before, cs0After })}`);

  if (/DUR\d+|1,001,403|SXR8|TSLA/.test(joePageSource)) throw new Error("Static /joe/ source still contains Paper-Drill account or position data");
  if (exceptions.length) throw new Error(`Runtime exceptions: ${exceptions.join("; ")}`);
  console.log(JSON.stringify({ healthy, mobile, stale, broken, stub: { ...stub, text: "private stub" }, dataRequests: requests.filter(item => item.path === "/joe/data.json") }, null, 2));
  await send("Browser.close").catch(() => {});
} finally {
  await cleanup();
}
