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
const dashboardHtml = await readFile(join(repoRoot, "public", "index.html"), "utf8");
const stringsSource = dashboardHtml.match(/const STRINGS = (\{[\s\S]*?\n\});/);
if (!stringsSource) throw new Error("Dashboard translations not found");
const allStrings = vm.runInNewContext(`(${stringsSource[1]})`);
const germanStrings = allStrings.de;
const englishStrings = allStrings.en;
// The status vocabulary is fixed (HOSTD-80/83): exactly these words, and distinct.
for (const [strings, words] of [[germanStrings, ["In Betrieb", "Ausgefallen", "Nicht erreichbar"]], [englishStrings, ["Running", "Down", "Unreachable"]]]) {
  const actual = [strings.status_running, strings.status_down, strings.status_unreachable];
  if (JSON.stringify(actual) !== JSON.stringify(words) || strings.status_stopped !== words[1] || new Set(actual).size !== 3) {
    throw new Error(`Status vocabulary drifted: ${JSON.stringify(actual)}`);
  }
}
const host = process.env.HOSTDASH_HOST || "hsb1";
const configMode = process.env.HOSTDASH_CONFIG_MODE || "config";
const manifestMode = configMode === "manifest";
const manifestContractMode = manifestMode && host === "hsb1";
// `cards` is every service the board shows; `total` is the "All" count in the group rail.
//
// `truthContainer`/`truthCard` name a PASSIVE, host-tracked service — no URL, so it is
// never probed and its LED is a pure function of status.json. That makes the host-truth
// assertions below deterministic and network-independent.
//
// `audience` is the board's presentation: family boards answer failures with "What now?"
// guidance, operator boards with an attention list.
const defaults = {
  hsb0: {
    cards: 18,
    total: 18,
    audience: "operator",
    density: "list",
    searchName: "AdGuard Home",
    searchTerm: "adguard",
    certService: null,
    sameHostService: "AdGuard Home",
    sameHostPort: "3000",
    sameHostPath: "/",
    // Served by this dashboard's own nginx: same origin, no port of its own.
    pathOnlyService: "hausnetz",
    pathOnlyPath: "/ops/",
    staticServices: {},
    truthContainer: "restic-cron-hetzner",
    truthCard: "restic",
    httpContainer: "ncps",
    httpCard: "NCPS",
  },
  hsb1: {
    cards: 27,
    total: 27,
    audience: "operator",
    density: "list",
    searchName: "Plex",
    searchTerm: "plex",
    certService: "Scrypted",
    sameHostService: "Plex",
    sameHostPort: "32400",
    sameHostPath: "/web",
    staticServices: {},
    truthContainer: "mosquitto",
    truthCard: "Mosquitto",
    httpContainer: "scrypted",
    httpCard: "Scrypted",
  },
  hsb8: {
    cards: 5,
    total: 5,
    audience: "family",
    density: "tiles",
    searchName: "Home Assistant",
    searchTerm: "assistant",
    certService: null,
    sameHostService: "Home Assistant",
    sameHostPort: "8123",
    sameHostPath: "/",
    staticServices: {},
    truthContainer: "mosquitto",
    truthCard: "Mosquitto",
    httpContainer: "homeassistant",
    httpCard: "Home Assistant",
    bindings: {
      "AdGuard Home": { unit: "adguardhome.service" },
      "Home Assistant": { container: "homeassistant" },
      Mosquitto: { container: "mosquitto" },
      "pharos-beacon": { container: "pharos-beacon" },
      "Container updates": { unit: "compose-hsb8-update.timer" },
    },
  },
  hsb9: {
    cards: 6,
    total: 6,
    audience: "family",
    density: "tiles",
    searchName: "Home Assistant",
    searchTerm: "assistant",
    certService: null,
    sameHostService: "Home Assistant",
    sameHostPort: "8123",
    sameHostPath: "/",
    // The recordings library is served by hsb9-home's own nginx (HOSTD-79).
    pathOnlyService: "Fernsehaufnahmen",
    pathOnlyPath: "/fernsehen/",
    staticServices: {},
    truthContainer: "mosquitto",
    truthCard: "Mosquitto",
    httpContainer: "homeassistant",
    httpCard: "Home Assistant",
    bindings: {
      "Home Assistant": { container: "homeassistant" },
      Fernsehaufnahmen: { container: "hsb9-media" },
      Mosquitto: { container: "mosquitto" },
      "pharos-beacon": { container: "pharos-beacon" },
      restic: { container: "restic-cron-hetzner" },
      "Container updates": { unit: "compose-hsb9-update.timer" },
    },
  },
  csb0: {
    cards: 14,
    total: 14,
    audience: "operator",
    density: "list",
    searchName: "Node-RED",
    searchTerm: "node-red",
    certService: null,
    sameHostService: null,
    sameHostPort: null,
    sameHostPath: null,
    staticServices: {},
    truthContainer: "csb0-mosquitto-1",
    truthCard: "Mosquitto",
    httpContainer: "csb0-nodered-1",
    httpCard: "Node-RED",
    bindings: {
      "Traefik API": { container: "csb0-traefik-1" },
      Headscale: { container: "headscale" },
      "Tesla Fleet Key": { container: "csb0-tesla-fleet-key-1" },
      "docker socket proxy": { container: "csb0-docker-proxy-traefik-1" },
      "HostDash login": { container: "csb0-hostdash-auth-1" },
      "Node-RED": { container: "csb0-nodered-1" },
      Mosquitto: { container: "csb0-mosquitto-1" },
      "Uptime Kuma": { container: "csb0-uptime-kuma-1" },
      "Joe board": { container: "csb0-joe-board-1" },
      "pharos-beacon": { container: "pharos-beacon" },
      "ops-alerts": { unit: "ops-alerts.timer" },
      "fleet-heartbeat": { unit: "fleet-heartbeat.socket" },
      restic: { container: "csb0-restic-cron-hetzner-1" },
      "Container updates": { unit: "compose-csb0-update.timer" },
    },
  },
  csb1: {
    cards: 47,
    total: 47,
    audience: "operator",
    density: "list",
    searchName: "Docmost",
    searchTerm: "knowledge",
    certService: null,
    sameHostService: null,
    sameHostPort: null,
    sameHostPath: null,
    // HOSTD-83 finding (b): a static status is a probe opt-out, never evidence. The
    // value is the container that alone may light the card.
    staticServices: {
      "INSPR site": "inspr-www",
    },
    truthContainer: "csb1-docmost-db-1",
    truthCard: "Docmost Postgres",
    httpContainer: "csb1-docmost-1",
    httpCard: "Docmost",
    bindings: {
      "Traefik API": { container: "csb1-traefik-1" },
      Zitadel: { container: "zitadel" },
      "inspr-auth": { container: "inspr-auth" },
      "docker socket proxy": { container: "csb1-docker-proxy-traefik-1" },
      "HostDash login": { container: "csb1-hostdash-auth-1" },
      Docmost: { container: "csb1-docmost-1" },
      Paperless: { container: "csb1-paperless-1" },
      Excalidraw: { container: "csb1-excalidraw-1" },
      Aeon: { container: "aeon" },
      "aeon-watch": { unit: "aeon-watch.timer" },
      "Janus placeholder": { container: "janus-placeholder" },
      "Janus transactiond": { container: "janus-managed-transactiond" },
      "Janus host agent": { unit: "janus-managed-host-agent.service" },
      MinIO: { container: "minio" },
      Pharos: { container: "pharosd" },
      "Pharos provisioning": { unit: "pharos-provisioning-executor.timer" },
      "Pharos retirement": { unit: "pharos-retirement-executor.timer" },
      Aithema: { unit: "aithema-workspace.service" },
      "WEG Portal": { container: "hausv-org" },
      "hausv-alerts": { unit: "hausv-alerts.timer" },
      "GitHub runner": { unit: "github-runner-csb1-hausv.service" },
      "INSPR site": { container: "inspr-www" },
      "PAIMOS site": { container: "paimos-www" },
      "jobs.at": { container: "csb1-jobs-at-1" },
      "barta.cm": { container: "csb1-barta-public-1" },
      BYTEPOETS: { container: "csb1-bytepoets-memorial-1" },
      "jhw22 heat pump": { container: "csb1-jhw22-wp-1" },
      "Docmost Postgres": { container: "csb1-docmost-db-1" },
      "Docmost Redis": { container: "csb1-docmost-redis-1" },
      "Paperless Postgres": { container: "csb1-paperless-db-1" },
      "Paperless Redis": { container: "csb1-paperless-redis-1" },
      "Paperless Tika": { container: "csb1-paperless-tika-1" },
      "Paperless Gotenberg": { container: "csb1-paperless-gotenberg-1" },
      "Zitadel Postgres": { container: "zitadel-postgres" },
      "Aeon Postgres": { container: "aeon-db" },
      "HAUSV Postgres": { container: "hausv-postgres" },
      restic: { container: "csb1-restic-cron-hetzner-1" },
      "SMTP relay": { container: "csb1-smtp-1" },
      "Container updates": { unit: "compose-csb1-update.timer" },
      "pharos-beacon": { container: "pharos-beacon" },
      "Aeon DB snapshot": { unit: "aeon-postgres-backup-snapshot.timer" },
      "HAUSV DB snapshot": { unit: "hausv-postgres-backup-snapshot.timer" },
      "HAUSV snapshot": { unit: "hausv-backup-snapshot.timer" },
      "fleet-peer-watch": { unit: "fleet-peer-watch.timer" },
      "tailnet-watch": { unit: "tailnet-watch.timer" },
      "fleet-drift": { unit: "fleet-drift.timer" },
      "fleet-heartbeat": { unit: "fleet-heartbeat.socket" },
    },
  },
};

// Short enough that the test observes several sweeps, long enough that a sweep's
// batches start before the next begins. Read by index.html via window.HOSTDASH_SWEEP_MS.
const sweepMs = Number(process.env.HOSTDASH_SWEEP_MS || 1200);
// Same-origin path probes (hausnetz, Fernsehaufnahmen) answer slower than a sweep on
// purpose. HOSTD-81 dropped every probe result that outlived a sweep, so under this
// delay its path-only cards never left "checking" (HOSTD-83 finding a).
const slowPathMs = Number(process.env.HOSTDASH_SLOW_PATH_MS || Math.round(sweepMs * 2.1));
const expectedString = (envName, key) =>
  process.env[envName] ??
  (Object.prototype.hasOwnProperty.call(defaults[host] || {}, key)
    ? defaults[host][key]
    : defaults.hsb1[key]);
const expected = {
  ...(defaults[host] || defaults.hsb1),
  cards: Number(
    process.env.EXPECTED_CARDS ||
      (defaults[host]?.cards || defaults.hsb1.cards) + (manifestContractMode ? 2 : 0),
  ),
  total: Number(
    process.env.EXPECTED_TOTAL ||
      (defaults[host]?.total || defaults.hsb1.total) + (manifestContractMode ? 2 : 0),
  ),
  searchName: expectedString("EXPECTED_SEARCH_NAME", "searchName"),
  searchTerm: expectedString("EXPECTED_SEARCH_TERM", "searchTerm"),
  certService: expectedString("EXPECTED_CERT_SERVICE", "certService"),
  sameHostService: expectedString("EXPECTED_SAME_HOST_SERVICE", "sameHostService"),
  sameHostPort: expectedString("EXPECTED_SAME_HOST_PORT", "sameHostPort"),
  sameHostPath: expectedString("EXPECTED_SAME_HOST_PATH", "sameHostPath"),
  configSource: process.env.EXPECTED_CONFIG_SOURCE || (manifestMode ? "manifest-json" : "config-js"),
};
const family = expected.audience === "family";

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

// The nixcfg manifest carries services but no presentation; the board's own config.js
// must still supply audience, density and contact (HOSTD-83). So these are stripped.
function manifestFromConfig(config) {
  const contractSentinels = config.slug === "hsb1"
    ? [
        {
          wing: config.wings[0].id,
          name: "Manifest binding sentinel",
          purpose: "Exercises every host-truth binding",
          icon: "server",
          passive: true,
          container: "manifest-container",
          unit: "manifest-unit.service",
          extra: "manifest-extra",
        },
        {
          wing: config.wings[0].id,
          name: "Manifest passive sentinel",
          purpose: "Pins explicit passive false without a URL",
          icon: "server",
          passive: false,
          status: "external",
        },
      ]
    : [];
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
    services: [
      ...config.services.map((service, index) =>
        index === 0 ? { ...service, urls: "invalid optional field", note: 42 } : service
      ),
      ...contractSentinels,
    ],
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
    // A directory-like path is a path-only service on this nginx: answer it late.
    if (name.endsWith("/")) await new Promise(done => setTimeout(done, slowPathMs));

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
    const manifest = manifestFromConfig(config);
    await writeFile(join(site, "manifest.json"), JSON.stringify(manifest, null, 2));
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
    // No artifact at all: the board must fall back to probes and claim nothing more.
    removeStatus: async () => rm(join(site, "status", "status.json"), { force: true }),
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
let browserLog = "";
browser.stderr.on("data", chunk => { browserLog = (browserLog + chunk).slice(-4000); });
let browserExit = null;
browser.on("exit", code => { browserExit = code; });

async function cleanup() {
  browser.kill("SIGTERM");
  await new Promise(resolve => setTimeout(resolve, 150));
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
  await localPage?.cleanup?.();
}

// A cold browser on a CI runner can take well over 8 s to open its DevTools port.
async function waitForJson(path) {
  const url = `http://127.0.0.1:${cdpPort}${path}`;
  for (let i = 0; i < 300; i += 1) {
    if (browserExit !== null) throw new Error(`Browser exited (${browserExit}) before DevTools came up: ${browserLog}`);
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

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

try {
  const pages = await waitForJson("/json/list");
  const page = pages.find(item => item.type === "page");
  if (!page) throw new Error("No browser page target found");

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const exceptions = [];
  // Every subresource the page itself loads must be same-origin or inline (AC8). Probe
  // fetches go to the configured services by design and are not counted here.
  const foreignResources = [];

  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.method === "Runtime.exceptionThrown") {
      exceptions.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text || "exception");
    }
    if (message.method === "Network.requestWillBeSent") {
      const { request, type } = message.params;
      if (type !== "Fetch" && !/^(data:|about:|http:\/\/127\.0\.0\.1:)/.test(request.url)) foreignResources.push(`${type} ${request.url}`);
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
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Runtime.evaluate failed");
    }
    return result.result.value;
  }

  const key = async (key, code, keyCode, text) => {
    await send("Input.dispatchKeyEvent", { type: "keyDown", key, code, ...(text ? { text } : {}), windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");
  await send("Input.setIgnoreInputEvents", { ignore: false });
  // Must land before the page's own module script runs, hence addScriptToEvaluateOnNewDocument
  // rather than an injected tag. Compresses the ~60 s production sweep to something a test
  // can sit through without making the app aware it is being tested.
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: `
      window.HOSTDASH_SWEEP_MS = ${sweepMs};
      Object.defineProperty(navigator, "languages", { configurable: true, get: () => ["fr-FR", "de-AT", "en-GB"] });
      Object.defineProperty(navigator, "language", { get: () => "fr-FR" });
    `,
  });
  await send("Page.navigate", { url: pageUrl });
  await sleep(2500);

  // Helpers evaluated in the page. Items are tiles (the link itself) or list rows
  // (an <li> around the link); both carry the same data attributes.
  const itemJs = `
    const items = () => [...document.querySelectorAll("#services [data-item]")];
    const nameOf = item => item.querySelector("[data-name]")?.dataset.name || null;
    const byName = name => items().find(item => nameOf(item) === name) || null;
    const linkOf = item => item ? (item.matches("a") ? item : item.querySelector("a")) : null;
    const visible = node => Boolean(node && !node.hidden && node.getClientRects().length && getComputedStyle(node).visibility !== "hidden");
    const wordNode = item => item.querySelector(".t-word") || item.querySelector(".badge");
  `;

  const languageState = () => value(`(() => {
    ${itemJs}
    const text = selector => document.querySelector(selector)?.textContent || "";
    const recordings = byName("Fernsehaufnahmen");
    const chrome = [...document.querySelectorAll(
      ".rail-h, #mainCount, .zoom-row2 .btn span, .grp .gn, #heroH, .truth-t.now, .fcard h3, .seg button span, .t-open-l, .guide h3, .hero-sub"
    )].map(node => node.textContent.trim()).concat(items().map(item => item.dataset.word || "").filter(Boolean));
    return {
      language: document.documentElement.lang,
      stored: localStorage.getItem("hostdash.lang"),
      heading: text("#mainTitle"),
      wings: [...document.querySelectorAll("#services .wing-h .wt")].map(node => node.textContent),
      purpose: recordings?.querySelector(".t-purpose, .r-purpose")?.textContent || null,
      cardNames: items().map(nameOf),
      role: text("#hostRole"), title: document.title,
      meta: text("#meta"),
      searchPlaceholder: document.getElementById("q").placeholder,
      groupLabel: document.getElementById("languageGroup").getAttribute("aria-label"),
      statusSourceTitle: document.getElementById("truthRow")?.title || "",
      pressed: [...document.querySelectorAll("[data-language][aria-pressed='true']")]
        .map(button => button.dataset.language),
      englishChrome: chrome.filter(text => /^(Running|Down|Unreachable|Reachable|Listening|No answer|Open|Open anyway|Groups|Size|Fit|Tiles|List|All|Failures|Help|Host|What now\\?|Layout)$/.test(text) ||
        /services running|not running|unreachable from|Host truth|No status file|What the lights mean|Checking services|Status file/.test(text)),
      englishAttributes: [...document.querySelectorAll("[aria-label], [title], [placeholder]")]
        .flatMap(node => [node.getAttribute("aria-label"), node.getAttribute("title"), node.getAttribute("placeholder")])
        .filter(text => text && /^(Search services|Language|Dark appearance|View zoom|Zoom out|Zoom in|Fit all services|Reset zoom to 100 %|Groups|Layout|Size)$/.test(text)),
    };
  })()`);
  const assertGerman = state => {
    if (state.language !== "de" || state.searchPlaceholder !== "Dienste suchen" ||
        state.groupLabel !== "Sprache" || JSON.stringify(state.pressed) !== '["de"]' ||
        !/^(Das Gerät selbst meldet|Kein nutzbarer Gerätestatus\.)/.test(state.statusSourceTitle) ||
        state.englishChrome.length || state.englishAttributes.length) {
      throw new Error(`German UI chrome did not translate: ${JSON.stringify(state)}`);
    }
    if (host === "hsb9" && (state.heading !== "Dienste" || !state.wings.includes("Zuhause & Medien") ||
        state.purpose !== "Aufnahmen ansehen, umbenennen, aufräumen" || state.role !== "Zuhause" ||
        state.title !== "hsb9 · Zuhause" || !state.meta.includes("Europa/Wien") ||
        !state.cardNames.includes("Container-Updates"))) {
      throw new Error(`hsb9 German config did not translate: ${JSON.stringify(state)}`);
    }
  };
  const assertEnglish = (state, stored = "en") => {
    if (state.language !== "en" || state.stored !== stored || state.searchPlaceholder !== "Search services" ||
        state.groupLabel !== "Language" || JSON.stringify(state.pressed) !== '["en"]') {
      throw new Error(`English language choice did not apply: ${JSON.stringify(state)}`);
    }
  };

  // ── NO EVIDENCE, NO CLAIM (HOSTD-81, HOSTD-83) ──────────────────────────────
  //
  // A lit LED and a status word are claims, made only on evidence. A card with no
  // evidence (checking, no or stale artifact, a passive card the artifact does not
  // list) shows dark glass, no word and no "Unknown"/"Unbekannt" anywhere, in either
  // language. Real failures (down, stopped, fault, failed runs) must still be visible
  // and named, in both densities.
  const evidenceViolations = () => value(`(() => {
    ${itemJs}
    const neutral = new Set(["checking", "unknown"]);
    const failed = new Set(["down", "stopped", "fault", "jobfail"]);
    return items().map(item => {
      const word = wordNode(item);
      const leds = [...item.querySelectorAll(".led")].map(led => led.dataset.l);
      return {
        name: nameOf(item),
        state: item.dataset.s, led: item.dataset.l, leds,
        word: item.dataset.word || "",
        shownWord: visible(word) ? word.textContent.trim() : "",
        listed: visible(item),
        alarming: /\\b(unknown|unbekannt)\\b/i.test(item.textContent),
      };
    }).filter(card => card.alarming ||
      (neutral.has(card.state) && (card.led !== "off" || card.word || card.shownWord || card.leds.some(l => l !== "off"))) ||
      (failed.has(card.state) && (card.led !== "bad" || (card.listed && !card.shownWord))) ||
      (!neutral.has(card.state) && card.led === "off"));
  })()`);
  const assertEvidence = async where => {
    const violations = await evidenceViolations();
    if (violations.length) {
      throw new Error(`Evidence rule broken (${where}): ${JSON.stringify(violations)}`);
    }
  };

  const defaultLanguage = await languageState();
  assertGerman(defaultLanguage);
  await assertEvidence("German, initial artifact");
  if (defaultLanguage.stored !== null) {
    throw new Error(`Browser default unexpectedly stored a preference: ${JSON.stringify(defaultLanguage)}`);
  }
  await value(`document.querySelector('[data-language="en"]').click()`);
  assertEnglish(await languageState());

  const reloadDashboard = async () => {
    await value("window.__beforeLanguageReload = true");
    await send("Page.reload");
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      try {
        if (await value(`!window.__beforeLanguageReload && document.querySelectorAll("#services [data-item]").length === ${expected.cards} &&
            Boolean(document.documentElement.dataset.configSource) &&
            document.querySelector('[data-language="en"]')?.getAttribute("aria-pressed") === "true"`)) return;
      } catch (error) {
        if (!/Execution context was destroyed|Cannot find context/.test(error.message)) throw error;
      }
      await sleep(100);
    }
    throw new Error("Dashboard did not finish reloading with the stored English preference");
  };
  const unsupportedLanguagesScript = await send("Page.addScriptToEvaluateOnNewDocument", {
    source: `Object.defineProperty(navigator, "languages", { get: () => ["fr-FR"] });`,
  });
  await value('localStorage.removeItem("hostdash.lang")');
  await reloadDashboard();
  const fallbackLanguage = await languageState();
  assertEnglish(fallbackLanguage, null);
  await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: unsupportedLanguagesScript.identifier });
  await value(`document.querySelector('[data-language="en"]').click()`);
  await reloadDashboard();
  const persistedLanguage = await languageState();
  assertEnglish(persistedLanguage);
  // All pre-existing host checks below run in English, including translated card
  // names such as hsb9's Container updates. German config is checked above.

  // Let a few sweeps run, then read one card. Reused after each status.json rewrite.
  const sampleCard = async name => {
    await sleep(sweepMs * 3);
    const readCard = () => value(`(() => {
      ${itemJs}
      const item = byName(${JSON.stringify(name)});
      const word = item ? wordNode(item) : null;
      return {
        state: item?.dataset.s || null,
        led: item?.dataset.l || null,
        word: item?.dataset.word || "",
        shown: Boolean(word && visible(word) && word.textContent.trim()),
        busy: item?.getAttribute("aria-busy") === "true",
        probed: item?.dataset.probed === "1",
        hostOk: item?.dataset.hostOk || null,
        title: (item?.title || item?.querySelector(".row")?.title) || null,
        truth: document.getElementById("truthRow")?.dataset.t || null,
        hostTruth: document.documentElement.dataset.hostTruth || null,
        verdict: document.documentElement.dataset.v || null,
        headline: document.getElementById("heroH")?.textContent || "",
      };
    })()`);
    // A first probe may still be in flight; wait for it, not for the endless re-checks.
    const deadline = Date.now() + 8000;
    let card = await readCard();
    while ((card.state === "checking" || (card.busy && !card.probed && card.led === "off")) && Date.now() < deadline) {
      await sleep(100);
      card = await readCard();
    }
    return card;
  };
  const sampleTruth = () => sampleCard(expected.truthCard);

  const initial = await value(`(() => {
    ${itemJs}
    const certName = ${JSON.stringify(expected.certService)};
    const sameHostName = ${JSON.stringify(expected.sameHostService)};
    const rail = document.getElementById("rail");
    return {
      configSource: document.documentElement.dataset.configSource,
      manifestAccent: getComputedStyle(document.documentElement).getPropertyValue("--manifest-accent").trim(),
      audience: document.documentElement.dataset.audience,
      density: document.documentElement.dataset.density,
      cards: items().length,
      total: document.querySelector('.grp[data-wing="all"] .n')?.textContent,
      headline: document.getElementById("heroH")?.textContent || "",
      search: document.getElementById("q")?.id,
      zoom: document.getElementById("zoomRange")?.value,
      controlsInRail: ["q", "zoomRange", "zoomOut", "zoomIn", "zoomFit", "zoomReset"].every(id => rail.contains(document.getElementById(id))),
      controlsInHeader: Boolean(document.querySelector(".top #q, .top #zoomRange")),
      certFlagged: certName ? (() => {
        const item = byName(certName);
        return item ? { certIssue: item.dataset.certIssue || null, probed: Boolean(item.dataset.probe) } : null;
      })() : null,
      staticServices: Object.fromEntries(Object.keys(${JSON.stringify(expected.staticServices || {})}).map(name => {
        const item = byName(name);
        return [name, item ? { static: item.dataset.static || null, probe: item.dataset.probe || null, state: item.dataset.s, led: item.dataset.l, word: item.dataset.word } : null];
      })),
      manifestContract: ${manifestContractMode ? `(() => {
        const binding = byName("Manifest binding sentinel");
        const explicitActive = byName("Manifest passive sentinel");
        return {
          binding: binding ? {
            container: binding.dataset.container || null,
            unit: binding.dataset.unit || null,
            extra: binding.dataset.extra || null,
            passive: binding.dataset.passive === "1",
          } : null,
          explicitActive: explicitActive ? {
            tag: linkOf(explicitActive)?.tagName || null,
            passive: explicitActive.dataset.passive === "1",
          } : null,
        };
      })()` : "null"},
      hostBindings: Object.fromEntries(items().flatMap(item => {
        const binding = {
          ...(item.dataset.container ? { container: item.dataset.container } : {}),
          ...(item.dataset.unit ? { unit: item.dataset.unit } : {}),
          ...(item.dataset.extra ? { extra: item.dataset.extra } : {}),
        };
        const name = nameOf(item);
        return name && Object.keys(binding).length ? [[name, binding]] : [];
      })),
      sameHostHref: sameHostName ? linkOf(byName(sameHostName))?.href || null : null,
      pathOnly: (() => {
        const name = ${JSON.stringify(expected.pathOnlyService || null)};
        const item = name ? byName(name) : null;
        return item ? {
          href: linkOf(item).href,
          probe: item.dataset.probe || null,
          foot: item.querySelector(".t-code, .r-foot")?.textContent || null,
        } : null;
      })(),
      unnamedButtons: [...document.querySelectorAll("button")].filter(button =>
        !(button.getAttribute("aria-label") || button.textContent.trim())).map(button => button.outerHTML.slice(0, 80)),
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
  // Presentation comes from the board's config.js even when a manifest supplies services.
  if (initial.audience !== expected.audience || initial.density !== expected.density) {
    throw new Error(`Board presentation (audience/density) not applied: ${JSON.stringify(initial)}`);
  }
  if (manifestContractMode) {
    const contract = initial.manifestContract;
    if (
      contract?.binding?.container !== "manifest-container" ||
      contract.binding.unit !== "manifest-unit.service" ||
      contract.binding.extra !== "manifest-extra" ||
      contract.binding.passive !== true
    ) {
      throw new Error(`Manifest host-truth bindings were not preserved: ${JSON.stringify(initial)}`);
    }
    if (contract?.explicitActive?.tag !== "A" || contract.explicitActive.passive !== false) {
      throw new Error(`Manifest passive derivation disagrees with config.js: ${JSON.stringify(initial)}`);
    }
  }
  if (initial.total !== String(expected.total)) {
    throw new Error(`Expected ${expected.total} services in the "All" group, got ${JSON.stringify(initial)}`);
  }
  if (expected.bindings) {
    const actualNames = Object.keys(initial.hostBindings).sort();
    const expectedNames = Object.keys(expected.bindings).sort();
    if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
      throw new Error(`Host binding inventory drifted: ${JSON.stringify({ actualNames, expectedNames })}`);
    }
    for (const [name, binding] of Object.entries(expected.bindings)) {
      if (JSON.stringify(initial.hostBindings[name]) !== JSON.stringify(binding)) {
        throw new Error(
          `Host binding for ${name} drifted: ${JSON.stringify({ actual: initial.hostBindings[name], expected: binding })}`,
        );
      }
    }
  }
  if (!initial.headline) {
    throw new Error(`Hero states nothing: ${JSON.stringify(initial)}`);
  }
  if (initial.search !== "q") {
    throw new Error(`Search input missing: ${JSON.stringify(initial)}`);
  }
  if (initial.zoom !== "100") {
    throw new Error(`Zoom control missing or wrong initial value: ${JSON.stringify(initial)}`);
  }
  if (!initial.controlsInRail || initial.controlsInHeader) {
    throw new Error(`Search and size controls are not in the group rail: ${JSON.stringify(initial)}`);
  }
  if (initial.unnamedButtons.length) {
    throw new Error(`Buttons without an accessible name: ${JSON.stringify(initial.unnamedButtons)}`);
  }
  // HOSTD-7 deliberately stopped painting a self-signed cert as a static "cert" badge.
  // What must hold is structural: the service carries the cert hint AND is genuinely
  // probed. Asserting the probe's OUTCOME would be asserting the test machine's network.
  if (expected.certService) {
    if (!initial.certFlagged) {
      throw new Error(`Cert-flagged service ${expected.certService} not found: ${JSON.stringify(initial)}`);
    }
    if (initial.certFlagged.certIssue !== "1" || !initial.certFlagged.probed) {
      throw new Error(`Expected ${expected.certService} to be cert-flagged and probed, got ${JSON.stringify(initial)}`);
    }
  }
  // HOSTD-83 finding (b): a static status is not probed and, without the host's word,
  // claims nothing at all (it used to read "External" in green).
  for (const name of Object.keys(expected.staticServices || {})) {
    const card = initial.staticServices[name];
    if (!card || !card.static || card.probe || card.led !== "off" || card.word || card.state === "external") {
      throw new Error(`Static status for ${name} bypassed the evidence rules: ${JSON.stringify(card)}`);
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
  // A path-only service keeps the dashboard's own origin (port included) for both the
  // link and the probe. That probe is same-origin and so readable: this test server
  // answers it 404 — and later than a sweep, so the result must survive steady sweeps
  // (finding a). It must read as a visible Down, never as reachable or as "checking".
  let pathOnlySample = null;
  if (expected.pathOnlyService && /^https?:/.test(pageUrl)) {
    const want = new URL(expected.pathOnlyPath, pageUrl).href;
    const card = initial.pathOnly;
    if (!card || card.href !== want || card.probe !== want || card.foot !== expected.pathOnlyPath) {
      throw new Error(`Path-only URL resolution failed: ${JSON.stringify({ want, pathOnly: card })}`);
    }
    if (localPage) {
      pathOnlySample = await sampleCard(expected.pathOnlyService);
      if (pathOnlySample.state !== "down" || pathOnlySample.led !== "bad" || !pathOnlySample.shown ||
          pathOnlySample.word !== englishStrings.status_down || !pathOnlySample.probed) {
        throw new Error(`Slow same-origin 404 was not reported as a visible Down (probe starved?): ${JSON.stringify({ slowPathMs, sweepMs, pathOnlySample })}`);
      }
    }
  }

  // ── HOST TRUTH REFRESH (HOSTD-11) ───────────────────────────────────────────
  //
  // The board exists to be left open for days, so it must re-read status.json on every
  // sweep, and an artifact older than STATUS_MAX_AGE_MS must stop counting as evidence.
  // All states asserted here are pure functions of status.json: the tracked card is
  // passive and has no URL, so nothing probes it and no network condition can flake it.
  let truthStates = null;
  if (truthCheck) {
    const stopped = await sampleTruth();
    if (stopped.state !== "stopped" || stopped.truth !== "live" || stopped.led !== "bad" ||
        !stopped.shown || stopped.word !== englishStrings.status_stopped || stopped.verdict !== "bad") {
      throw new Error(
        `Expected ${expected.truthCard} stopped under live host truth, got ${JSON.stringify(stopped)}`,
      );
    }
    // A failure is loud and comes with guidance: "What now?" for a family board (with
    // the contact's first name, never a phone link), an attention list for an operator.
    const failureHelp = await value(`(() => ({
      guide: document.querySelector("#hero .guide")?.textContent || "",
      chips: [...document.querySelectorAll("#hero .att-chip b")].map(node => node.textContent),
      telLinks: document.querySelectorAll('a[href^="tel:"]').length,
      problems: document.querySelector('.grp[data-wing="problems"] .n')?.textContent || null,
    }))()`);
    if (failureHelp.telLinks || failureHelp.problems === null ||
        (family ? !/What now\?/.test(failureHelp.guide) : !failureHelp.chips.includes(expected.truthCard))) {
      throw new Error(`Failure guidance missing: ${JSON.stringify(failureHelp)}`);
    }
    await assertEvidence("host reports a stopped service");

    // Same tab, no reload: the host changes its mind and the board must follow.
    await localPage.writeStatus({ [expected.truthContainer]: { running: true } });
    const running = await sampleTruth();
    if (running.state !== "running" || running.truth !== "live" || running.led !== "on") {
      throw new Error(`Board did not pick up refreshed host truth, got ${JSON.stringify(running)}`);
    }

    // HOSTD-83 finding (b), with evidence: only the host's word may light a static card.
    for (const [name, container] of Object.entries(expected.staticServices || {})) {
      await localPage.writeStatus({ [expected.truthContainer]: { running: true }, [container]: { running: true } });
      const lit = await sampleCard(name);
      await localPage.writeStatus({ [expected.truthContainer]: { running: true }, [container]: { running: false } });
      const down = await sampleCard(name);
      if (lit.state !== "running" || lit.led !== "on" || down.state !== "stopped" || down.led !== "bad" || !down.shown) {
        throw new Error(`Static status ${name} did not follow host evidence: ${JSON.stringify({ lit, down })}`);
      }
      await localPage.writeStatus({ [expected.truthContainer]: { running: true } });
    }

    // Generator has gone quiet. Trusting this file would leave the card lit indefinitely;
    // the only honest answer is dark glass — and the board says why.
    await localPage.writeStatus({ [expected.truthContainer]: { running: true } }, 600);
    const stale = await sampleTruth();
    // A measured failure that needs no host truth (a same-origin 404) still outranks the
    // stale notice; otherwise the hero says how long the host has been silent.
    const measuredFailure = await value(`document.querySelectorAll('#services [data-item][data-l="bad"]').length`);
    if (stale.state !== "unknown" || stale.truth !== "stale" || stale.hostTruth !== "absent" ||
        stale.led !== "off" || stale.word ||
        (measuredFailure ? stale.verdict !== "bad" : stale.verdict !== "quiet" || !/10/.test(stale.headline))) {
      throw new Error(`Stale host truth was not discarded, got ${JSON.stringify({ stale, measuredFailure })}`);
    }
    await assertEvidence("stale artifact");
    const staleGuide = await value(`document.querySelector("#hero .guide, #hero .next, #hero .att-chip")?.textContent || ""`);
    if (!staleGuide) throw new Error("Stale state shows no guidance");

    // No artifact at all (404): same honest fallback, in both languages.
    await localPage.removeStatus();
    const none = await sampleTruth();
    if (none.state !== "unknown" || none.truth !== "none" || none.hostTruth !== "absent" || none.led !== "off" || none.word) {
      throw new Error(`Missing artifact did not fall back to no claim, got ${JSON.stringify(none)}`);
    }
    await assertEvidence("no artifact");
    await value(`document.querySelector('[data-language="de"]').click()`);
    await assertEvidence("German, no artifact");
    const noneDe = await value(`({ label: document.getElementById("truthLabel").textContent, title: document.getElementById("truthRow").title })`);
    if (noneDe.label !== germanStrings.tr_none || !/nicht gefunden/.test(noneDe.title)) {
      throw new Error(`German no-artifact state does not say so: ${JSON.stringify(noneDe)}`);
    }
    await value(`document.querySelector('[data-language="en"]').click()`);

    truthStates = { stopped, failureHelp, running, stale, none, noneDe };
  }

  // ── HOST-SIDE HTTP TRUTH (HOSTD-12) ─────────────────────────────────────────
  //
  // The browser probe is opaque: it resolves on a 500 exactly as it does on a 200. Only
  // the host can see a status code. These fixtures feed the board codes it could never
  // obtain client-side and assert it says the true thing.
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
    if (fault.state !== "fault" || fault.word !== "HTTP 503" || !fault.shown || fault.led !== "bad") {
      throw new Error(`Expected ${expected.httpCard} to report HTTP 503, got ${JSON.stringify(fault)}`);
    }

    // Container up, nothing answering behind it — curl's 000.
    const silent = await withHttp(0);
    if (silent.state !== "fault" || silent.word !== englishStrings.noAnswer || !silent.shown) {
      throw new Error(`Expected ${expected.httpCard} to report no answer, got ${JSON.stringify(silent)}`);
    }

    // Host gets a clean 200. Whether THIS browser can also reach it is a property of the
    // machine running the test, so only the unreachable branch is asserted in detail —
    // the Scrypted case: running per host, the path from here is what is broken.
    const ok = await withHttp(200);
    if (ok.state === "unreachable") {
      if (ok.word !== englishStrings.status_unreachable || ok.led !== "split" || ok.hostOk !== "200" || !/HTTP 200/.test(ok.title || "")) {
        throw new Error(`Host-confirmed service was not labelled as running but unreachable: ${JSON.stringify(ok)}`);
      }
    } else if (ok.state !== "up" || ok.led !== "on") {
      throw new Error(`Expected ${expected.httpCard} up or unreachable on HTTP 200, got ${JSON.stringify(ok)}`);
    }

    httpStates = { fault, silent, ok };
  }

  // ── LAYOUT: phone width ─────────────────────────────────────────────────────
  await send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await sleep(200);
  const mobileLayout = await value(`(() => {
    const visible = node => Boolean(node && node.getClientRects().length && getComputedStyle(node).display !== "none");
    const before = visible(document.getElementById("zoomRange"));
    document.getElementById("viewToggle").click();
    const after = visible(document.getElementById("zoomRange"));
    document.getElementById("viewToggle").click();
    return {
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      searchVisible: visible(document.getElementById("q")),
      groupsVisible: visible(document.querySelector("#groups .grp")),
      sizeHiddenUntilAsked: !before && after,
      languageVisible: ["de", "en"].every(language => {
        const button = document.querySelector('[data-language="' + language + '"]');
        const box = button?.getBoundingClientRect();
        return Boolean(visible(button) && box.width >= 44 && box.height >= 44 &&
          box.left >= 0 && box.right <= document.documentElement.clientWidth);
      }),
    };
  })()`);
  if (mobileLayout.overflow || !mobileLayout.searchVisible || !mobileLayout.groupsVisible ||
      !mobileLayout.sizeHiddenUntilAsked || !mobileLayout.languageVisible) {
    throw new Error(`Controls are not usable on mobile: ${JSON.stringify(mobileLayout)}`);
  }
  await send("Emulation.clearDeviceMetricsOverride");

  // ── ZOOM 50–200 %, per board ────────────────────────────────────────────────
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
      text: document.getElementById("zoomValue").textContent,
      stored: localStorage.getItem(${JSON.stringify(`hostdash.${host}.zoom`)}),
    })
  `);
  if (
    steppedZoomState.zoom !== "0.8" ||
    steppedZoomState.value !== "80" ||
    steppedZoomState.text !== "80 %" ||
    steppedZoomState.stored !== "80"
  ) {
    throw new Error(`Zoom step buttons failed: ${JSON.stringify(steppedZoomState)}`);
  }
  const fitState = await value(`(() => {
    document.getElementById("zoomFit").click();
    return {
      pressed: document.getElementById("zoomFit").getAttribute("aria-pressed"),
      mode: localStorage.getItem(${JSON.stringify(`hostdash.${host}.zoomMode`)}),
      zoom: Number(document.getElementById("zoomRange").value),
    };
  })()`);
  if (fitState.pressed !== "true" || fitState.mode !== "fit" || !(fitState.zoom >= 50 && fitState.zoom <= 100)) {
    throw new Error(`Fit all services failed: ${JSON.stringify(fitState)}`);
  }
  await value(`document.getElementById("zoomReset").click(); true`);

  // ── DENSITY AND APPEARANCE, remembered ──────────────────────────────────────
  // The switch runs inside a view transition where the browser has one, so read after it.
  const other = await value(`(() => {
    const other = document.documentElement.dataset.density === "list" ? "tiles" : "list";
    document.querySelector('[data-density="' + other + '"]').click();
    return other;
  })()`);
  await sleep(500);
  const densityState = { other, switched: await value(`({
    density: document.documentElement.dataset.density,
    items: document.querySelectorAll("#services [data-item]").length,
    tiles: document.querySelectorAll("#services .tile").length,
    rows: document.querySelectorAll("#services .row-li").length,
    stored: localStorage.getItem(${JSON.stringify(`hostdash.${host}.density`)}),
  })`) };
  await assertEvidence(`after switching to ${densityState.other}`);
  await value(`document.querySelector('[data-density="${expected.density}"]').click(); true`);
  await sleep(400);
  if (densityState.switched.density !== densityState.other || densityState.switched.items !== expected.cards ||
      densityState.switched.stored !== densityState.other ||
      (densityState.other === "tiles" ? densityState.switched.tiles : densityState.switched.rows) !== expected.cards) {
    throw new Error(`Tiles/List switch failed: ${JSON.stringify(densityState)}`);
  }
  const themeState = await value(`(() => {
    const before = document.documentElement.dataset.theme;
    document.getElementById("themeSwitch").click();
    const after = document.documentElement.dataset.theme;
    const stored = localStorage.getItem("hostdash.theme");
    const checked = document.getElementById("themeSwitch").getAttribute("aria-checked");
    document.getElementById("themeSwitch").click();
    return { before, after, stored, checked, restored: document.documentElement.dataset.theme };
  })()`);
  if (themeState.before === themeState.after || themeState.stored !== themeState.after ||
      themeState.checked !== String(themeState.after === "dark") || themeState.restored !== themeState.before) {
    throw new Error(`Light/dark switch failed: ${JSON.stringify(themeState)}`);
  }

  // ── SEARCH: "/" focuses, Esc clears, a second Esc leaves ─────────────────────
  await key("/", "Slash", 191, "/");
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
  const visibleNames = `[...document.querySelectorAll("#services [data-item]")]
      .filter(item => !item.hidden && !item.closest("[hidden]"))
      .map(item => item.querySelector("[data-name]").dataset.name)`;
  const searchState = await value(`({
    visibleCards: ${visibleNames},
    empty: document.getElementById("empty").hidden,
    count: document.getElementById("count").textContent,
  })`);
  if (
    searchState.visibleCards.length !== 1 ||
    searchState.visibleCards[0] !== expected.searchName ||
    searchState.empty !== true ||
    !/1 of/.test(searchState.count)
  ) {
    throw new Error(`Search filter failed: ${JSON.stringify(searchState)}`);
  }

  await key("Escape", "Escape", 27);
  const firstEscape = await value(`({ value: document.getElementById("q").value, active: document.activeElement && document.activeElement.id, visible: ${visibleNames}.length })`);
  await key("Escape", "Escape", 27);
  const escapeState = await value(`({ value: document.getElementById("q").value, active: document.activeElement && document.activeElement.id })`);
  if (firstEscape.value !== "" || firstEscape.active !== "q" || firstEscape.visible !== expected.cards || escapeState.active === "q") {
    throw new Error(`Escape did not clear, then leave: ${JSON.stringify({ firstEscape, escapeState })}`);
  }

  const retainedState = await value(`(() => {
    document.querySelector('#groups .grp:not([data-wing="all"]):not([data-wing="problems"])').click();
    const q = document.getElementById("q");
    q.value = ${JSON.stringify(expected.searchTerm)};
    q.dispatchEvent(new Event("input", { bubbles: true }));
    const zoom = document.getElementById("zoomRange");
    zoom.value = "75";
    zoom.dispatchEvent(new Event("input", { bubbles: true }));
    window.__languageSwitchMarker = "same document";
    const before = {
      search: q.value,
      filter: document.querySelector('#groups .grp[aria-pressed="true"]').dataset.wing,
      zoom: zoom.value,
    };
    document.querySelector('[data-language="de"]').click();
    return { before, after: {
      search: q.value,
      filter: document.querySelector('#groups .grp[aria-pressed="true"]').dataset.wing,
      zoom: zoom.value,
    }, marker: window.__languageSwitchMarker, stored: localStorage.getItem("hostdash.lang"),
      storedFilter: localStorage.getItem(${JSON.stringify(`hostdash.${host}.wing`)}) };
  })()`);
  assertGerman(await languageState());
  await assertEvidence("German, after language switch");
  if (JSON.stringify(retainedState.before) !== JSON.stringify(retainedState.after) ||
      retainedState.marker !== "same document" || retainedState.stored !== "de" ||
      retainedState.storedFilter !== retainedState.before.filter) {
    throw new Error(`Language switch lost current view state: ${JSON.stringify(retainedState)}`);
  }
  let localizedSearch = null;
  if (host === "hsb9") {
    localizedSearch = await value(`(() => {
      const q = document.getElementById("q");
      document.querySelector('#groups .grp[data-wing="all"]').click();
      q.value = "aufräumen";
      q.dispatchEvent(new Event("input", { bubbles: true }));
      const german = ${visibleNames};
      document.querySelector('[data-language="en"]').click();
      return { german, english: ${visibleNames}, query: q.value };
    })()`);
    if (JSON.stringify(localizedSearch.german) !== '["Fernsehaufnahmen"]' ||
        localizedSearch.english.length || localizedSearch.query !== "aufräumen") {
      throw new Error(`Search did not follow displayed config language: ${JSON.stringify(localizedSearch)}`);
    }
  }
  await value(`(() => {
    document.querySelector('[data-language="en"]').click();
    document.querySelector('#groups .grp[data-wing="all"]').click();
    const q = document.getElementById("q");
    q.value = "";
    q.dispatchEvent(new Event("input", { bubbles: true }));
    document.getElementById("zoomReset").click();
  })()`);

  // A separate same-origin document produces a real storage event, like another
  // dashboard tab or /fernsehen/. A synthetic event alone would miss browser wiring.
  const siblingPreference = next => value(`new Promise((resolve, reject) => {
    const frame = document.createElement("iframe");
    frame.hidden = true;
    frame.srcdoc = "<!doctype html><title>Shared language preference</title>";
    const finish = () => {
      clearTimeout(timeout);
      window.removeEventListener("storage", changed);
      frame.remove();
    };
    const changed = event => {
      if (event.key !== "hostdash.lang") return;
      finish();
      resolve(document.documentElement.lang);
    };
    const timeout = setTimeout(() => { finish(); reject(new Error("No shared-language storage event")); }, 3000);
    window.addEventListener("storage", changed);
    frame.onload = () => {
      const next = ${JSON.stringify(next)};
      if (next === null) frame.contentWindow.localStorage.removeItem("hostdash.lang");
      else frame.contentWindow.localStorage.setItem("hostdash.lang", next);
    };
    document.body.appendChild(frame);
  })`);
  await siblingPreference("de");
  const sharedLanguage = await languageState();
  assertGerman(sharedLanguage);
  await siblingPreference("fr");
  assertGerman(await languageState());
  await siblingPreference(null);
  assertGerman(await languageState());
  await siblingPreference("en");
  assertEnglish(await languageState());

  if (exceptions.length) {
    throw new Error(`Runtime exceptions: ${exceptions.join("; ")}`);
  }
  if (foreignResources.length) {
    throw new Error(`The page loaded resources from elsewhere: ${foreignResources.join("; ")}`);
  }

  console.log(
    JSON.stringify({ host, pageUrl, initial, pathOnlySample, truthStates, httpStates, mobileLayout, densityState, themeState,
      searchState, firstEscape, escapeState, defaultLanguage, fallbackLanguage, persistedLanguage, retainedState,
      localizedSearch, sharedLanguage }, null, 2),
  );
  await send("Browser.close").catch(() => {});
} finally {
  await cleanup();
}
