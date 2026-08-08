#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import vm from "node:vm";

const browserPath =
  process.env.BROWSER_PATH || "/Applications/Helium.app/Contents/MacOS/Helium";
const cdpPort = Number(process.env.CDP_PORT || 9349);
const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const host = process.env.HOSTDASH_HOST || "hsb1";
const configMode = process.env.HOSTDASH_CONFIG_MODE || "config";
const manifestMode = configMode === "manifest";
// `total` is `cardIndex.length` — every card the board claims to track, i.e. active
// services PLUS passive ones the host can vouch for (container/unit/extra). It is not
// the service count. These drifted badly once HOSTD-7 started tracking passive cards
// and HOSTD-10 added extras; five of six hosts were asserting pre-HOSTD-7 numbers.
//
// `truthContainer`/`truthCard` name a PASSIVE, host-tracked service — no URL, so it is
// never probed and its badge is a pure function of status.json. That makes the
// host-truth assertions below deterministic and network-independent.
const defaults = {
  hsb0: {
    cards: 9,
    total: 9,
    searchName: "AdGuard Home",
    searchTerm: "adguard",
    certService: "OpenClaw Gateway",
    sameHostService: "AdGuard Home",
    sameHostPort: "3000",
    sameHostPath: "/",
    staticStates: {},
    truthContainer: "restic-cron-hetzner",
    truthCard: "restic",
    httpContainer: "openclaw-gateway",
    httpCard: "OpenClaw Gateway",
  },
  hsb1: {
    cards: 19,
    total: 18,
    searchName: "Plex",
    searchTerm: "plex",
    certService: "Scrypted",
    sameHostService: "Plex",
    sameHostPort: "32400",
    sameHostPath: "/web",
    staticStates: {},
    truthContainer: "mosquitto",
    truthCard: "Mosquitto",
    httpContainer: "scrypted",
    httpCard: "Scrypted",
  },
  hsb8: {
    cards: 5,
    total: 2,
    searchName: "Home Assistant",
    searchTerm: "assistant",
    certService: null,
    sameHostService: "Home Assistant",
    sameHostPort: "8123",
    sameHostPath: "/",
    staticStates: {},
    truthContainer: null,
    truthCard: null,
    httpContainer: null,
    httpCard: null,
  },
  hsb9: {
    cards: 4,
    total: 1,
    searchName: "Home Assistant",
    searchTerm: "assistant",
    certService: null,
    sameHostService: "Home Assistant",
    sameHostPort: "8123",
    sameHostPath: "/",
    staticStates: {},
    truthContainer: null,
    truthCard: null,
    httpContainer: null,
    httpCard: null,
  },
  csb0: {
    cards: 11,
    total: 5,
    searchName: "Node-RED",
    searchTerm: "node-red",
    certService: null,
    sameHostService: null,
    sameHostPort: null,
    sameHostPath: null,
    staticStates: {},
    truthContainer: null,
    truthCard: null,
    httpContainer: null,
    httpCard: null,
  },
  csb1: {
    cards: 26,
    total: 14,
    searchName: "Docmost",
    searchTerm: "knowledge",
    certService: null,
    sameHostService: null,
    sameHostPort: null,
    sameHostPath: null,
    staticStates: {
      Janus: "protected",
      "INSPR site": "external",
    },
    truthContainer: null,
    truthCard: null,
    httpContainer: null,
    httpCard: null,
  },
};

// Short enough that the test observes several sweeps, long enough that a sweep's
// batches finish before the next begins. Read by index.html via window.HOSTDASH_SWEEP_MS.
const sweepMs = Number(process.env.HOSTDASH_SWEEP_MS || 1200);
const expectedString = (envName, key) =>
  process.env[envName] ??
  (Object.prototype.hasOwnProperty.call(defaults[host] || {}, key)
    ? defaults[host][key]
    : defaults.hsb1[key]);
const expected = {
  ...(defaults[host] || defaults.hsb1),
  cards: Number(process.env.EXPECTED_CARDS || defaults[host]?.cards || defaults.hsb1.cards),
  total: Number(process.env.EXPECTED_TOTAL || defaults[host]?.total || defaults.hsb1.total),
  searchName: expectedString("EXPECTED_SEARCH_NAME", "searchName"),
  searchTerm: expectedString("EXPECTED_SEARCH_TERM", "searchTerm"),
  certService: expectedString("EXPECTED_CERT_SERVICE", "certService"),
  sameHostService: expectedString("EXPECTED_SAME_HOST_SERVICE", "sameHostService"),
  sameHostPort: expectedString("EXPECTED_SAME_HOST_PORT", "sameHostPort"),
  sameHostPath: expectedString("EXPECTED_SAME_HOST_PATH", "sameHostPath"),
  configSource: process.env.EXPECTED_CONFIG_SOURCE || (manifestMode ? "manifest-json" : "config-js"),
};

async function readHostConfig(hostName) {
  const configPath = join(repoRoot, "hosts", hostName, "config.js");
  const source = await readFile(configPath, "utf8");
  const sandbox = { window: {} };
  vm.runInNewContext(source, sandbox, { filename: configPath });
  if (!sandbox.window.HOSTDASH_CONFIG) {
    throw new Error(`No HOSTDASH_CONFIG exported by ${configPath}`);
  }
  return sandbox.window.HOSTDASH_CONFIG;
}

function manifestFromConfig(config) {
  return {
    schema: "inspr.hostdash.config.v1",
    version: 1,
    generatedBy: "hostdash-smoke",
    slug: config.slug,
    storageKey: config.storageKey,
    host: config.host,
    meta: [...(config.meta || []), { ignored: true }],
    palette: {
      name: "custom-hsb8",
      displayName: "Custom (hsb8)",
      category: "custom",
      description: "Smoke-test palette generated from nixcfg manifest shape",
      accent: "#e09051",
      gradient: {
        lightest: "#ecba93",
        primary: "#e09051",
        secondary: "#c26923",
        midDark: "#572f0f",
        dark: "#341c09",
        darker: "#231306",
        darkest: "#160c04",
      },
      text: {},
      zellij: {},
    },
    wings: config.wings.map((wing, index) => index === 0 ? { ...wing, color: 42 } : wing),
    services: config.services.map((service, index) =>
      index === 0 ? { ...service, urls: "invalid optional field", note: 42 } : service
    ),
    policy: {
      declaredOnly: true,
      runtimeStateOwner: "pharos",
      privilegedActions: {
        mode: "none",
        janusRequired: false,
      },
    },
  };
}

async function serveDirectory(root) {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    const name = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
    if (!name || name.includes("..") || name.startsWith("/")) {
      response.writeHead(400);
      response.end("bad request");
      return;
    }

    try {
      const file = await readFile(join(root, name));
      const type = name.endsWith(".html")
        ? "text/html; charset=utf-8"
        : name.endsWith(".js")
          ? "text/javascript; charset=utf-8"
          : name.endsWith(".json")
            ? "application/json; charset=utf-8"
            : "application/octet-stream";
      response.writeHead(200, { "content-type": type });
      response.end(file);
    } catch {
      response.writeHead(404);
      response.end("not found");
    }
  });

  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}/index.html`,
    cleanup: () => new Promise(resolve => server.close(resolve)),
  };
}

// Always over HTTP, never file://. The board reads host truth from a SAME-ORIGIN
// ./status/status.json, and file:// has no usable origin — under it the fetch always
// fails and every host-truth path in the app is silently untested.
async function localPageUrl() {
  const site = await mkdtemp(join(tmpdir(), "hostdash-site-"));
  await cp(join(repoRoot, "public"), site, { recursive: true });
  await copyFile(join(repoRoot, "hosts", host, "config.js"), join(site, "config.js"));
  await mkdir(join(site, "status"), { recursive: true });
  if (manifestMode) {
    const config = await readHostConfig(host);
    await writeFile(join(site, "manifest.json"), JSON.stringify(manifestFromConfig(config), null, 2));
  }
  const server = await serveDirectory(site);
  return {
    url: server.url,
    // ageSec lets a test hand the board a deliberately old artifact and watch it
    // degrade to "stale" instead of trusting it.
    writeStatus: async (containers, ageSec = 0, http = {}) =>
      writeFile(
        join(site, "status", "status.json"),
        JSON.stringify({
          schema: "inspr.hostdash.status.v1",
          generated: Math.floor(Date.now() / 1000) - ageSec,
          containers,
          units: {},
          extras: {},
          http,
        }),
      ),
    cleanup: async () => {
      await server.cleanup();
      await rm(site, { recursive: true, force: true });
    },
  };
}

const localPage = process.env.PAGE_URL ? null : await localPageUrl();
const pageUrl = process.env.PAGE_URL || localPage.url;
const truthCheck = Boolean(localPage?.writeStatus && expected.truthContainer);

// Open with the host reporting the tracked service as STOPPED, so the first paint has
// something unambiguous in it that no probe could have produced.
if (truthCheck) await localPage.writeStatus({ [expected.truthContainer]: { running: false } });

const profile = await mkdtemp(join(tmpdir(), "hostdash-smoke-"));
const browser = spawn(browserPath, [
  "--headless=new",
  "--disable-gpu",
  `--remote-debugging-port=${cdpPort}`,
  `--user-data-dir=${profile}`,
  "about:blank",
]);

browser.stdout.resume();
browser.stderr.resume();

async function cleanup() {
  browser.kill("SIGTERM");
  await new Promise(resolve => setTimeout(resolve, 150));
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
  await localPage?.cleanup?.();
}

async function waitForJson(path) {
  const url = `http://127.0.0.1:${cdpPort}${path}`;
  for (let i = 0; i < 80; i += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch {
      // Browser not ready yet.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

try {
  const pages = await waitForJson("/json/list");
  const page = pages.find(item => item.type === "page");
  if (!page) throw new Error("No browser page target found");

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const exceptions = [];

  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.method === "Runtime.exceptionThrown") {
      exceptions.push(message.params.exceptionDetails.text || "exception");
    }
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    }
  };

  await new Promise(resolve => {
    ws.onopen = resolve;
  });

  function send(method, params = {}) {
    const messageId = ++id;
    ws.send(JSON.stringify({ id: messageId, method, params }));
    return new Promise((resolve, reject) => {
      pending.set(messageId, { resolve, reject });
    });
  }

  async function value(expression) {
    const result = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || "Runtime.evaluate failed");
    }
    return result.result.value;
  }

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Input.setIgnoreInputEvents", { ignore: false });
  // Must land before the page's own module script runs, hence addScriptToEvaluateOnNewDocument
  // rather than an injected tag. Compresses the ~30s production sweep to something a test
  // can sit through without making the app aware it is being tested.
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.HOSTDASH_SWEEP_MS = ${sweepMs};`,
  });
  await send("Page.navigate", { url: pageUrl });
  await new Promise(resolve => setTimeout(resolve, 2500));

  // Let a few sweeps run, then read one card. Reused after each status.json rewrite.
  const sampleCard = async name => {
    await new Promise(resolve => setTimeout(resolve, sweepMs * 3));
    return value(`(() => {
      const card = [...document.querySelectorAll(".svc")]
        .find(item => item.querySelector("h3")?.textContent === ${JSON.stringify(name)});
      return {
        state: card?.querySelector(".state")?.dataset.s || null,
        label: card?.querySelector(".state-label")?.textContent || null,
        hostOk: card?.dataset.hostOk || null,
        title: card?.title || null,
        truth: document.getElementById("truthRow")?.dataset.t || null,
        hostTruth: document.documentElement.dataset.hostTruth || null,
      };
    })()`);
  };
  const sampleTruth = () => sampleCard(expected.truthCard);

  const initial = await value(`(() => {
    const certName = ${JSON.stringify(expected.certService)};
    const sameHostName = ${JSON.stringify(expected.sameHostService)};
    const sameHostCard = sameHostName ? [...document.querySelectorAll(".svc")]
      .find(card => card.querySelector("h3")?.textContent === sameHostName) : null;
    return {
      configSource: document.documentElement.dataset.configSource,
      manifestAccent: getComputedStyle(document.documentElement).getPropertyValue("--manifest-accent").trim(),
      cards: document.querySelectorAll(".svc").length,
      total: document.getElementById("totCount").textContent,
      online: document.getElementById("onCount").textContent,
      search: document.getElementById("q")?.id,
      zoom: document.getElementById("zoomRange")?.value,
      controlsInSidebar: Boolean(
        document.querySelector(".side .controls #q") &&
        document.querySelector(".side .controls #zoomRange") &&
        document.querySelector(".side .controls #zoomOut") &&
        document.querySelector(".side .controls #zoomIn") &&
        document.querySelector(".side .controls #zoomFit") &&
        document.querySelector(".side .controls #zoomReset")
      ),
      controlsInTopbar: Boolean(document.querySelector(".topbar #q, .topbar #zoomRange")),
      zoomNestedInSearch: Boolean(document.querySelector("label.search .zoom")),
      certFlagged: certName ? (() => {
        const card = [...document.querySelectorAll(".svc")]
          .find(item => item.querySelector("h3")?.textContent === certName);
        return card ? { certIssue: card.dataset.certIssue || null, probed: Boolean(card.dataset.probe) } : null;
      })() : null,
      staticStates: Object.fromEntries(Object.keys(${JSON.stringify(expected.staticStates || {})}).map(name => {
        const card = [...document.querySelectorAll(".svc")]
          .find(item => item.querySelector("h3")?.textContent === name);
        return [name, card?.querySelector(".state")?.dataset.s || null];
      })),
      sameHostHref: sameHostCard?.href || null
    };
  })()`);

  if (initial.cards !== expected.cards) {
    throw new Error(`Expected ${expected.cards} service cards, got ${JSON.stringify(initial)}`);
  }
  if (initial.configSource !== expected.configSource) {
    throw new Error(`Expected config source ${expected.configSource}, got ${JSON.stringify(initial)}`);
  }
  if (manifestMode && initial.manifestAccent.toLowerCase() !== "#e09051") {
    throw new Error(`Manifest palette was not applied: ${JSON.stringify(initial)}`);
  }
  if (initial.total !== String(expected.total)) {
    throw new Error(`Expected ${expected.total} active services, got ${JSON.stringify(initial)}`);
  }
  if (!/^\d+$/.test(initial.online)) {
    throw new Error(`Online count is not numeric: ${JSON.stringify(initial)}`);
  }
  if (initial.search !== "q") {
    throw new Error(`Search input missing: ${JSON.stringify(initial)}`);
  }
  if (initial.zoom !== "100") {
    throw new Error(`Zoom control missing or wrong initial value: ${JSON.stringify(initial)}`);
  }
  if (!initial.controlsInSidebar || initial.controlsInTopbar || initial.zoomNestedInSearch) {
    throw new Error(`Search and zoom controls are not in the sidebar control rail: ${JSON.stringify(initial)}`);
  }
  // HOSTD-7 deliberately stopped painting a self-signed cert as a static "cert" badge —
  // that was a workaround for the probe's blindness, and it asserted a state nobody had
  // measured. What must hold now is structural: the service still carries the cert hint
  // AND is genuinely probed rather than given a hardcoded answer. Asserting the probe's
  // OUTCOME here would be asserting the test machine's network, not the app.
  if (expected.certService) {
    if (!initial.certFlagged) {
      throw new Error(`Cert-flagged service ${expected.certService} not found: ${JSON.stringify(initial)}`);
    }
    if (initial.certFlagged.certIssue !== "1" || !initial.certFlagged.probed) {
      throw new Error(`Expected ${expected.certService} to be cert-flagged and probed, got ${JSON.stringify(initial)}`);
    }
  }
  for (const [name, state] of Object.entries(expected.staticStates || {})) {
    if (initial.staticStates[name] !== state) {
      throw new Error(`Expected ${name} state ${state}, got ${JSON.stringify(initial)}`);
    }
  }
  if (expected.sameHostService && /^https?:/.test(pageUrl)) {
    const actual = new URL(initial.sameHostHref);
    const current = new URL(pageUrl);
    if (
      actual.hostname !== current.hostname ||
      actual.port !== expected.sameHostPort ||
      actual.pathname !== expected.sameHostPath
    ) {
      throw new Error(`Same-host URL resolution failed: ${JSON.stringify({ pageUrl, initial })}`);
    }
  }

  // ── HOST TRUTH REFRESH (HOSTD-11) ───────────────────────────────────────────
  //
  // The board exists to be left open for days. Before HOSTD-11 it read status.json once,
  // at page load, so every "Running"/"Stopped" badge described the host as it was when
  // the tab was opened — and STATUS_MAX_AGE_MS, the guard against a dead generator, could
  // never fire, because it was only ever evaluated on data that was fresh by construction.
  //
  // All three states asserted here are pure functions of status.json: the tracked card is
  // passive and has no URL, so nothing probes it and no network condition can flake it.
  let truthStates = null;
  if (truthCheck) {
    const stopped = await sampleTruth();
    if (stopped.state !== "stopped" || stopped.truth !== "live") {
      throw new Error(
        `Expected ${expected.truthCard} stopped under live host truth, got ${JSON.stringify(stopped)}`,
      );
    }

    // Same tab, no reload: the host changes its mind and the board must follow.
    await localPage.writeStatus({ [expected.truthContainer]: { running: true } });
    const running = await sampleTruth();
    if (running.state !== "running" || running.truth !== "live") {
      throw new Error(`Board did not pick up refreshed host truth, got ${JSON.stringify(running)}`);
    }

    // Generator has gone quiet. Trusting this file would leave the card reading "Running"
    // indefinitely; the only honest answer is that the board no longer knows.
    await localPage.writeStatus({ [expected.truthContainer]: { running: true } }, 600);
    const stale = await sampleTruth();
    if (stale.state !== "unknown" || stale.truth !== "stale" || stale.hostTruth !== "absent") {
      throw new Error(`Stale host truth was not discarded, got ${JSON.stringify(stale)}`);
    }

    truthStates = { stopped, running, stale };
  }

  // ── HOST-SIDE HTTP TRUTH (HOSTD-12) ─────────────────────────────────────────
  //
  // The browser probe is opaque: it resolves on a 500 exactly as it does on a 200, so a
  // broken service read "Online". Only the host can see a status code. These fixtures
  // feed the board codes it could never obtain client-side and assert it says the true
  // thing — the first two deterministically, since both short-circuit before any probe.
  let httpStates = null;
  if (truthCheck && expected.httpContainer) {
    const base = {
      [expected.truthContainer]: { running: true },
      [expected.httpContainer]: { running: true },
    };
    const withHttp = async code => {
      await localPage.writeStatus(base, 0, { [expected.httpContainer]: { code, ms: 11 } });
      return sampleCard(expected.httpCard);
    };

    // The service itself reports failure. Outranks the probe entirely.
    const fault = await withHttp(503);
    if (fault.state !== "fault" || fault.label !== "HTTP 503") {
      throw new Error(`Expected ${expected.httpCard} to report HTTP 503, got ${JSON.stringify(fault)}`);
    }

    // Container up, nothing answering behind it — curl's 000. A service failure, not a
    // routing one, and invisible to every other signal on the board.
    const silent = await withHttp(0);
    if (silent.state !== "fault" || silent.label !== "no answer") {
      throw new Error(`Expected ${expected.httpCard} to report no answer, got ${JSON.stringify(silent)}`);
    }

    // Host gets a clean 200. Whether THIS browser can also reach it is a property of the
    // machine running the test, so only the unreachable branch is asserted — that branch
    // is the Scrypted case, and it must name the service as healthy rather than shrug.
    const ok = await withHttp(200);
    if (ok.state === "unreachable") {
      if (ok.label !== "OK on host" || ok.hostOk !== "200" || !/HTTP 200/.test(ok.title || "")) {
        throw new Error(`Host-confirmed service was not labelled as healthy: ${JSON.stringify(ok)}`);
      }
    } else if (ok.state !== "up") {
      throw new Error(`Expected ${expected.httpCard} up or unreachable on HTTP 200, got ${JSON.stringify(ok)}`);
    }

    httpStates = { fault, silent, ok };
  }

  await send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await new Promise(resolve => setTimeout(resolve, 150));
  const mobileLayout = await value(`(() => {
    const side = document.querySelector(".side");
    const controls = document.querySelector(".side .controls");
    const sideBox = side?.getBoundingClientRect();
    const controlsBox = controls?.getBoundingClientRect();
    return {
      sideDisplay: side ? getComputedStyle(side).display : null,
      controlsDisplay: controls ? getComputedStyle(controls).display : null,
      sideWidth: sideBox ? Math.round(sideBox.width) : 0,
      controlsWidth: controlsBox ? Math.round(controlsBox.width) : 0,
      searchVisible: Boolean(document.querySelector(".side .controls #q")?.offsetParent),
      zoomVisible: Boolean(document.querySelector(".side .controls #zoomRange")?.offsetParent),
    };
  })()`);
  if (
    mobileLayout.sideDisplay === "none" ||
    mobileLayout.controlsDisplay === "none" ||
    mobileLayout.sideWidth < 300 ||
    mobileLayout.controlsWidth < 250 ||
    !mobileLayout.searchVisible ||
    !mobileLayout.zoomVisible
  ) {
    throw new Error(`Sidebar controls are not usable on mobile: ${JSON.stringify(mobileLayout)}`);
  }
  await send("Emulation.clearDeviceMetricsOverride");

  const zoomState = await value(`
    const zoom = document.getElementById("zoomRange");
    zoom.value = "75";
    zoom.dispatchEvent(new Event("input", { bubbles: true }));
    getComputedStyle(document.documentElement).getPropertyValue("--zoom").trim()
  `);
  if (zoomState !== "0.75") {
    throw new Error(`Zoom slider did not update CSS zoom: ${zoomState}`);
  }
  const steppedZoomState = await value(`
    document.getElementById("zoomOut").click();
    document.getElementById("zoomIn").click();
    document.getElementById("zoomIn").click();
    ({
      zoom: getComputedStyle(document.documentElement).getPropertyValue("--zoom").trim(),
      value: document.getElementById("zoomRange").value,
      text: document.getElementById("zoomValue").textContent
    })
  `);
  if (
    steppedZoomState.zoom !== "0.8" ||
    steppedZoomState.value !== "80" ||
    steppedZoomState.text !== "80%"
  ) {
    throw new Error(`Zoom step buttons failed: ${JSON.stringify(steppedZoomState)}`);
  }
  await value(`
    document.getElementById("zoomReset").click();
    true
  `);

  await send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "/",
    code: "Slash",
    text: "/",
    windowsVirtualKeyCode: 191,
    nativeVirtualKeyCode: 191,
  });
  const focused = await value("document.activeElement && document.activeElement.id");
  if (focused !== "q") {
    throw new Error(`Slash hotkey did not focus search; active=${focused}`);
  }

  await value(`
    const q = document.getElementById("q");
    q.value = ${JSON.stringify(expected.searchTerm)};
    q.dispatchEvent(new Event("input", { bubbles: true }));
    true
  `);
  const searchState = await value(`({
    visibleCards: [...document.querySelectorAll(".svc")]
      .filter(card => !card.classList.contains("hidden") && !card.closest(".wing").classList.contains("hidden"))
      .map(card => card.querySelector("h3")?.textContent),
    empty: getComputedStyle(document.getElementById("empty")).display
  })`);
  if (
    searchState.visibleCards.length !== 1 ||
    searchState.visibleCards[0] !== expected.searchName ||
    searchState.empty !== "none"
  ) {
    throw new Error(`Search filter failed: ${JSON.stringify(searchState)}`);
  }

  await send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
  });
  const escapeState = await value(`({
    value: document.getElementById("q").value,
    active: document.activeElement && document.activeElement.id,
    visible: [...document.querySelectorAll(".svc")]
      .filter(card => !card.classList.contains("hidden") && !card.closest(".wing").classList.contains("hidden"))
      .length
  })`);
  if (escapeState.value !== "" || escapeState.active === "q" || escapeState.visible !== expected.cards) {
    throw new Error(`Escape reset failed: ${JSON.stringify(escapeState)}`);
  }

  if (exceptions.length) {
    throw new Error(`Runtime exceptions: ${exceptions.join("; ")}`);
  }

  console.log(
    JSON.stringify({ host, pageUrl, initial, truthStates, httpStates, searchState, escapeState }, null, 2),
  );
  await send("Browser.close").catch(() => {});
} finally {
  await cleanup();
}
