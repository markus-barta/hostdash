#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const WebSocketClient = globalThis.WebSocket || require("undici").WebSocket;

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const browserPath = process.env.BROWSER_PATH || "/usr/bin/google-chrome";
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
  return snapshot;
}

await writeSnapshot();
const historyPoints = Array.from({ length: 8 }, (_, index) => ({
  t: new Date(Date.now() - (7 - index) * 3600_000).toISOString(),
  desks: {
    j: { equity: 10000 + index * 4, dayPnl: index * 4, totalPnl: 100 + index * 4 },
    joe: { equity: 10000 - index, dayPnl: -index, totalPnl: -40 - index },
    joel: { equity: 10000 + index * 2, dayPnl: index * 2, totalPnl: 230 + index * 2 },
  },
  totals: { equity: 30000 + index * 5, dayPnl: index * 5, totalPnl: 290 + index * 5 },
}));
await writeFile(join(site, "joe", "history.json"), JSON.stringify({
  schema: "inspr.joe.household.history.v1",
  generatedAt: new Date().toISOString(),
  currency: "EUR",
  points: historyPoints,
}));

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
    const type = relative.endsWith(".json") ? "application/json"
      : relative.endsWith(".css") ? "text/css; charset=utf-8"
        : relative.endsWith(".js") ? "text/javascript; charset=utf-8"
          : "text/html; charset=utf-8";
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
  "--no-sandbox",
  "--disable-dev-shm-usage",
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
  const ws = new WebSocketClient(page.webSocketDebuggerUrl);
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
  const smokeMode = process.env.JOE_SMOKE_VIEWPORT || "desktop";
  const mobileViewport = smokeMode === "mobile";
  await send("Emulation.setDeviceMetricsOverride", mobileViewport
    ? { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }
    : { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  const hsb1Url = `http://hsb1.lan:${sitePort}/joe/`;
  let healthy;
  let mobile;
  let stale;
  let broken;
  let stub;
  let richSnapshot;

  if (smokeMode === "privacy") {
    const cs0Before = requests.filter(item => item.host.startsWith("cs0.barta.cm") && item.path === "/joe/data.json").length;
    await navigate(`http://cs0.barta.cm:${sitePort}/joe/`, "document.documentElement.dataset.joeView === 'stub'");
    await delay(250);
    stub = await value(`({ view: document.documentElement.dataset.joeView, gateHidden: document.getElementById('privateGate')?.hidden, dashboardHidden: document.getElementById('dashboard')?.hidden, text: document.body.innerText })`);
    const cs0After = requests.filter(item => item.host.startsWith("cs0.barta.cm") && item.path === "/joe/data.json").length;
    if (stub.view !== "stub" || stub.gateHidden || !stub.dashboardHidden || !/Joe lives at home/.test(stub.text) || cs0After !== cs0Before) throw new Error(`cs0 privacy stub mismatch: ${JSON.stringify({ stub, cs0Before, cs0After })}`);
  } else {
    await navigate(hsb1Url, "document.documentElement.dataset.joeState");
    healthy = await value(`(() => ({
    view: document.documentElement.dataset.joeView,
    state: document.documentElement.dataset.joeState,
    deskIds: [...document.querySelectorAll('.desk-widget')].map(node => node.dataset.desk),
    states: [...document.querySelectorAll('.state')].map(node => node.textContent),
    total: document.getElementById('totalEquity')?.textContent,
    gateway: document.getElementById('gatewayValue')?.textContent,
    halt: document.getElementById('haltValue')?.textContent,
    alarmHidden: document.getElementById('alarm')?.hidden,
    gridReady: Boolean(document.getElementById('joeGrid')?.gridstack),
    widgets: document.querySelectorAll('#joeGrid > .grid-stack-item').length,
    selectedSeries: document.querySelectorAll('button[data-series][aria-pressed="true"]').length,
    positionFallback: document.getElementById('positionsBody')?.innerText,
    zoomPlugin: Boolean(window.Chart?.registry?.plugins?.get('zoom')),
    externalScripts: [...document.scripts].filter(script => script.src && new URL(script.src).origin !== location.origin).length,
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  }))()`);
    if (
      healthy.view !== "board" || healthy.state !== "ok" ||
      JSON.stringify(healthy.deskIds) !== JSON.stringify(["j", "joe", "joel"]) ||
      !healthy.states.includes("Working") || !healthy.states.includes("Sitting out") ||
      !/30[\.\s]000/.test(healthy.total || "") || healthy.gateway !== "OK · connected" ||
      !healthy.halt.startsWith("Off") || !healthy.alarmHidden || !healthy.gridReady || healthy.widgets !== 7 ||
      healthy.selectedSeries !== 2 || !/not present/i.test(healthy.positionFallback || "") || !healthy.zoomPlugin || healthy.externalScripts || healthy.overflow
    ) throw new Error(`Healthy board mismatch: ${JSON.stringify(healthy)}`);

    if (process.env.JOE_SCREENSHOT_DIR) {
      const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
      await writeFile(join(process.env.JOE_SCREENSHOT_DIR, mobileViewport ? "joe-dash-mobile.png" : "joe-dash-desktop.png"), Buffer.from(shot.data, "base64"));
    }

    if (mobileViewport) {
      mobile = await value(`(() => ({
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      gridColumns: document.getElementById('joeGrid')?.gridstack?.getColumn(),
      gateHidden: document.getElementById('privateGate').hidden,
      heroClipped: (() => { const hero = document.querySelector('[gs-id="hero"] .grid-stack-item-content'); return hero.scrollHeight > hero.clientHeight + 1; })(),
      heroOpen: document.getElementById('totalOpen')?.textContent,
      heroFreshness: document.getElementById('freshValue')?.textContent,
      offenders: [...document.querySelectorAll('body *')].filter(node => node.getBoundingClientRect().right > document.documentElement.clientWidth + 1).slice(0, 8).map(node => ({ tag: node.tagName, id: node.id, className: String(node.className), right: Math.round(node.getBoundingClientRect().right), width: Math.round(node.getBoundingClientRect().width) })),
      }))()`);
      if (mobile.overflow || mobile.gridColumns !== 1 || !mobile.gateHidden || mobile.heroClipped || !mobile.heroOpen || !mobile.heroFreshness) throw new Error(`Mobile layout mismatch: ${JSON.stringify(mobile)}`);
    } else {
      const staleSnapshot = structuredClone(sample);
      staleSnapshot.generatedAt = new Date(Date.now() - 3600_000).toISOString();
      stale = await value(`(() => { window.JoeBoard.ingest(${JSON.stringify(staleSnapshot)}); return { state: document.documentElement.dataset.joeState, freshness: document.getElementById('freshValue')?.textContent, alarm: document.getElementById('alarmText')?.textContent }; })()`);
      if (stale.state !== "attention" || !stale.freshness.startsWith("STALE") || !/stale/i.test(stale.alarm || "")) throw new Error(`Stale state mismatch: ${JSON.stringify(stale)}`);

      const brokenSnapshot = structuredClone(sample);
      brokenSnapshot.generatedAt = new Date().toISOString();
      brokenSnapshot.safety.halt = true;
      brokenSnapshot.safety.haltReason = "Operator check";
      brokenSnapshot.safety.gateway.status = "down";
      brokenSnapshot.safety.gateway.detail = "No heartbeat";
      broken = await value(`(() => { window.JoeBoard.ingest(${JSON.stringify(brokenSnapshot)}); return { state: document.documentElement.dataset.joeState, alarm: document.getElementById('alarmText')?.textContent }; })()`);
      if (broken.state !== "attention" || !/HALT is on/.test(broken.alarm || "") || !/Gateway is down/.test(broken.alarm || "")) throw new Error(`Broken state mismatch: ${JSON.stringify(broken)}`);

      const positionsSnapshot = structuredClone(sample);
      positionsSnapshot.generatedAt = new Date().toISOString();
      positionsSnapshot.totals.openPnl = 17.25;
      positionsSnapshot.desks[0].money.openPnl = 12.5;
      positionsSnapshot.desks[0].tradeCount = 4;
      positionsSnapshot.positions = [
        { desk: "j", symbol: "DEMO1", side: "Long", quantity: 2, mark: 101, marketValue: 202, dayPnl: 4.5, openPnl: 12.5, updatedAt: new Date().toISOString() },
        { desk: "joel", symbol: "DEMO2", side: "Short", quantity: -1, mark: 88, marketValue: -88, dayPnl: -1, openPnl: 4.75, updatedAt: new Date().toISOString() },
      ];
      richSnapshot = await value(`(() => { window.JoeBoard.ingest(${JSON.stringify(positionsSnapshot)}); return { rows: document.querySelectorAll('#positionsBody tr').length, symbols: document.getElementById('positionsBody')?.innerText, open: document.getElementById('totalOpen')?.textContent, tradeCount: document.querySelector('[data-desk-slot="j"] .desk-money-row')?.innerText }; })()`);
      if (richSnapshot.rows !== 2 || !/DEMO1/.test(richSnapshot.symbols || "") || !/17,25/.test(richSnapshot.open || "") || !/4/.test(richSnapshot.tradeCount || "")) throw new Error(`Rich snapshot mismatch: ${JSON.stringify(richSnapshot)}`);

      const layout = await value(`(async () => { const board = document.getElementById('joeGrid'); const grid = board.gridstack; const hero = document.querySelector('[gs-id="hero"]'); grid.update(hero, { h: 3 }); await new Promise(resolve => setTimeout(resolve, 50)); const saved = JSON.parse(localStorage.getItem('joe-board-layout-v1')); document.getElementById('resetLayout').click(); await new Promise(resolve => setTimeout(resolve, 50)); return { savedHeight: saved.find(item => item.id === 'hero')?.h, resetHeight: hero.gridstackNode.h, storageCleared: localStorage.getItem('joe-board-layout-v1') === null }; })()`);
      if (layout.savedHeight !== 3 || layout.resetHeight !== 2 || !layout.storageCleared) throw new Error(`Layout persistence mismatch: ${JSON.stringify(layout)}`);
    }
  }

  const source = await readFile(join(repoRoot, "public", "joe", "index.html"), "utf8");
  if (/DUR\d+|1,001,403|SXR8|TSLA/.test(source)) throw new Error("Static /joe/ source still contains Paper-Drill account or position data");
  if (exceptions.length) throw new Error(`Runtime exceptions: ${exceptions.join("; ")}`);
  console.log(JSON.stringify({ healthy, mobile, stale, broken, richSnapshot, stub: stub && { ...stub, text: "private stub" }, dataRequests: requests.filter(item => item.path === "/joe/data.json") }, null, 2));
  await send("Browser.close").catch(() => {});
  ws.close();
} finally {
  await cleanup();
}
