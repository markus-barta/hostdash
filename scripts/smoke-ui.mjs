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
    // A self-reporting service (HOSTD-10): its telemetry is evidence only when it is an
    // explicit health report (HOSTD-83 gate r1 M7).
    selfReportCard: "Babycam",
    selfReportKey: "babycam",
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
      (defaults[host]?.cards || defaults.hsb1.cards) + (manifestContractMode ? 3 : 0),
  ),
  total: Number(
    process.env.EXPECTED_TOTAL ||
      (defaults[host]?.total || defaults.hsb1.total) + (manifestContractMode ? 3 : 0),
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
        // HOSTD-83 gate r1 M5: same-host services resolve against the dashboard's own
        // origin and need no canonical `url`. The path is one this test server answers
        // 200, so the sentinel adds no failure of its own.
        {
          wing: config.wings[0].id,
          name: "Manifest same-host sentinel",
          purpose: "Same-host service without a canonical url",
          icon: "server",
          sameHost: true,
          path: "/config.js",
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

// `control.manifest` makes the optional manifest misbehave (HOSTD-83 gate r2): "hang"
// never answers, "body" sends headers and half a body, then nothing.
async function serveDirectory(root, control = { manifest: "normal" }) {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    const name = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
    if (!name || name.includes("..") || name.startsWith("/")) {
      response.writeHead(400);
      response.end("bad request");
      return;
    }
    if (name === "manifest.json" && control.manifest === "hang") return;
    if (name === "manifest.json" && control.manifest === "body") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.write('{"schema": "inspr.hostdash.config.v1", "version": 1, "services": [');
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
    cleanup: () => new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections?.();
    }),
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
  const control = { manifest: "normal" };
  const server = await serveDirectory(site, control);
  const configSource = await readFile(join(site, "config.js"), "utf8");
  const manifestSource = manifestMode ? await readFile(join(site, "manifest.json"), "utf8") : null;
  return {
    url: server.url,
    setManifest: mode => { control.manifest = mode; },
    // Probe disabled in the config (`probe: false`) on every active service, in
    // whichever source this board reads its services from. `false` restores it.
    setProbeDisabled: async disabled => {
      await writeFile(join(site, "config.js"), disabled
        ? `${configSource}\n;window.HOSTDASH_CONFIG.services.forEach(service => { if (service.passive !== true) service.probe = false; });\n`
        : configSource);
      if (manifestSource) {
        const manifest = JSON.parse(manifestSource);
        if (disabled) manifest.services.forEach(service => { if (service.passive !== true) service.probe = false; });
        await writeFile(join(site, "manifest.json"), JSON.stringify(manifest, null, 2));
      }
    },
    // ageSec lets a test hand the board a deliberately old artifact and watch it
    // degrade to "stale" instead of trusting it.
    // `more` adds units/extras/jobs, or replaces `generated` with a raw value.
    writeStatus: async (containers, ageSec = 0, http = {}, more = {}) =>
      writeFile(
        join(site, "status", "status.json"),
        JSON.stringify({
          schema: "inspr.hostdash.status.v1",
          generated: "generated" in more ? more.generated : Math.floor(Date.now() / 1000) - ageSec,
          containers,
          units: more.units || {},
          extras: more.extras || {},
          http,
          ...(more.jobs ? { jobs: more.jobs } : {}),
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

// Facts the round-1 checks take from the board's own config rather than a table.
const hostConfig = await readHostConfig(host);
const englishOf = value => typeof value === "string" ? value : value?.en;
// Passive, unit-bound services without a URL: their records alone decide their cards.
const passiveUnits = hostConfig.services.filter(service => service.passive === true && typeof service.unit === "string" && !service.url);
// A timer or socket: inactive means stopped, whatever its last run said (HOSTD-83 gate
// r2 M1; round 1 wrongly treated these as oneshots here).
const timerService = passiveUnits.find(service => /\.(timer|socket)$/.test(service.unit)) || null;
// A .service unit, which the test artifact identifies as a oneshot (Type=oneshot): the
// only kind of unit whose "inactive" with an ok last run is a finished job.
const oneshotService = passiveUnits.find(service => /\.service$/.test(service.unit)) || null;
const jobUnitService = timerService || oneshotService;
// For the malformed-record checks: the first host-bound service in sweep (config) order,
// and the last passive container after it, whose update a throw would have cut off.
const boundServices = hostConfig.services.filter(service => service.container || service.unit);
// Not the path-only service: its same-origin 404 is a real, measured "Down".
const hostileService = boundServices.find(service => ![expected.truthCard, expected.httpCard, expected.pathOnlyService].includes(englishOf(service.name))) || null;
const laterService = [...boundServices].reverse().find(service => service.container && service.passive === true && !service.url &&
  service !== hostileService && ![expected.truthCard, expected.httpCard].includes(englishOf(service.name)) &&
  boundServices.indexOf(service) > boundServices.indexOf(hostileService)) || null;
// The path-only service's own host binding (hausnetz.service, hsb9-media).
const pathOnlyConfig = expected.pathOnlyService ? hostConfig.services.find(service => englishOf(service.name) === expected.pathOnlyService) : null;

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

// The HOSTD-83 gate round-1 checks throw like every other check. With SMOKE_SOFT=1 they
// are collected instead and the run goes on, so one run against an older board lists
// every round-1 check it fails (how the PR shows each one failing before its fix).
const softMode = process.env.SMOKE_SOFT === "1";
const softFailures = [];
const round1Fail = message => {
  if (!softMode) throw new Error(message);
  const head = message.split(":")[0];
  if (!softFailures.some(line => line.split(":")[0] === head)) softFailures.push(message.slice(0, 400));
};

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
  // Set by the probe control below while it intercepts requests (CDP Fetch domain).
  let onPaused = null;

  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.method === "Fetch.requestPaused") onPaused?.(message.params);
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

  // ── PROBE CONTROL (HOSTD-83 gate r2) ────────────────────────────────────────
  // The round-2 checks need reachability they decide themselves, not the test machine's
  // network. While a policy is set, every request that is not one of the board's own
  // files (page, config, manifest, status) is answered here: "ok" (an HTTP 200),
  // "fail" (connection refused) or "hold" (never answered until released). The board's
  // own files always go to the test server.
  const pageOrigin = new URL(pageUrl).origin;
  const appFile = url => {
    try {
      const u = new URL(url);
      return u.origin === pageOrigin && /^\/(index\.html|config\.js|manifest\.json|status\/status\.json)?$/.test(u.pathname);
    } catch { return false; }
  };
  let probePolicy = null;
  const heldRequests = [];
  const answer = (requestId, action) => (action === "ok"
    ? send("Fetch.fulfillRequest", { requestId, responseCode: 200, responseHeaders: [{ name: "content-type", value: "text/plain" }], body: Buffer.from("ok").toString("base64") })
    : action === "fail" ? send("Fetch.failRequest", { requestId, errorReason: "ConnectionRefused" })
      : send("Fetch.continueRequest", { requestId })).catch(() => {}); // the page may have given up on it already
  onPaused = ({ requestId, request }) => {
    const action = appFile(request.url) || !probePolicy ? "continue" : probePolicy(request.url);
    if (action === "hold") heldRequests.push(requestId);
    else answer(requestId, action);
  };
  const controlProbes = async policy => {
    if (policy && !probePolicy) await send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
    if (!policy && probePolicy) {
      await releaseHeld("fail");
      await send("Fetch.disable");
    }
    probePolicy = policy;
  };
  async function releaseHeld(action) {
    for (const requestId of heldRequests.splice(0)) await answer(requestId, action);
  }
  // Missing keys read as the key itself, so a run against an older board fails a check
  // instead of crashing the test.
  const fmt = (key, vars = {}) => (englishStrings[key] ?? key).replace(/\{(\w+)\}/g, (match, name) => vars[name] ?? match);

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
    const purposeOf = item => item.querySelector(".t-purpose, .r-purpose")?.textContent || "";
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
      purposes: items().map(purposeOf),
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
    // HOSTD-83 L-a: the stock section heading is chrome and follows the language on every
    // board (hsb1 read "Services" in German while hsb9 read "Dienste").
    if (state.heading !== "Dienste") {
      round1Fail(`Section heading did not follow the language switch: ${JSON.stringify(state.heading)}`);
    }
    // HOSTD-83 L-b: hsb8 is a family board; its names and purposes speak German too.
    if (host === "hsb8" && (!state.wings.includes("Hausautomation") || !state.cardNames.includes("Container-Updates") ||
        !state.purposes.includes("Zentrale der Hausautomation") || state.role !== "Zuhause" ||
        state.title !== "hsb8 · Zuhause" || !state.meta.includes("Europa/Wien"))) {
      round1Fail(`hsb8 German config did not translate: ${JSON.stringify(state)}`);
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
  // Let sweeps run until no card is still checking, then read the board's verdict.
  const sampleBoard = async () => {
    await sleep(sweepMs * 3);
    const read = () => value(`(() => ({
      verdict: document.documentElement.dataset.v || null,
      truth: document.getElementById("truthRow")?.dataset.t || null,
      hostTruth: document.documentElement.dataset.hostTruth || null,
      lens: document.querySelector("#hero .lens .led")?.dataset.l || null,
      headline: document.getElementById("heroH")?.textContent || "",
      truthLabel: document.getElementById("truthLabel")?.textContent || "",
      vouched: [...document.querySelectorAll('#services [data-item][data-l="on"], #services [data-item][data-l="dim"]')].length,
    }))()`);
    const deadline = Date.now() + 10000;
    let board = await read();
    while (board.verdict === "checking" && Date.now() < deadline) {
      await sleep(150);
      board = await read();
    }
    return board;
  };
  // Where keyboard focus is now, in words a failure message can show.
  const focusState = () => value(`(() => {
    const node = document.activeElement;
    return {
      tag: node?.tagName || null, id: node?.id || null, fk: node?.dataset?.fk || null,
      item: node?.closest?.("#services [data-item]")?.dataset.item || null,
      inHero: Boolean(node?.closest?.("#hero")), inRail: Boolean(node?.closest?.("#groups")),
      group: node?.closest?.("#groups .grp")?.dataset.wing || null,
      body: node === document.body || node === null,
    };
  })()`);

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
        const sameHost = byName("Manifest same-host sentinel");
        return {
          sameHost: sameHost ? { href: linkOf(sameHost)?.getAttribute("href") ? linkOf(sameHost).href : null, probe: sameHost.dataset.probe || null } : null,
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
    const sameHostWant = new URL("/config.js", pageUrl).href;
    if (contract?.sameHost?.href !== sameHostWant || contract.sameHost.probe !== sameHostWant) {
      round1Fail(`Same-host service without a canonical url lost its link or probe: ${JSON.stringify({ sameHostWant, sameHost: contract?.sameHost })}`);
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

    // HOSTD-83 gate r1 L3: a background refresh never drops keyboard focus. Focus the
    // failure's own control (an operator's attention chip, a family board's guide
    // button), let the service recover, and focus must land on something stable (the
    // service itself, or the hero heading), never on <body>.
    const truthKey = await value(`(() => { ${itemJs} return byName(${JSON.stringify(expected.truthCard)})?.dataset.item || null; })()`);
    const focusedControl = await value(`(() => {
      const control = ${family ? `document.querySelector('#hero .guide [data-act="reload"]')` : `document.querySelector('#hero .att-chip[data-key="' + ${JSON.stringify(truthKey)} + '"]')`};
      control?.focus();
      return control ? control.dataset.fk : null;
    })()`);
    if (!focusedControl) round1Fail(`No failure control to focus for ${expected.truthCard}`);

    // Same tab, no reload: the host changes its mind and the board must follow.
    await localPage.writeStatus({ [expected.truthContainer]: { running: true } });
    const running = await sampleTruth();
    if (running.state !== "running" || running.truth !== "live" || running.led !== "on") {
      throw new Error(`Board did not pick up refreshed host truth, got ${JSON.stringify(running)}`);
    }
    const heroFocus = await focusState();
    if (heroFocus.body || !(heroFocus.inHero || heroFocus.item === truthKey)) {
      round1Fail(`Recovery dropped keyboard focus from ${focusedControl}: ${JSON.stringify(heroFocus)}`);
    }
    // The Failures group disappears with the last failure: focus moves to All, not <body>.
    await localPage.writeStatus({ [expected.truthContainer]: { running: false } });
    await sampleTruth();
    const focusedGroup = await value(`(() => { const group = document.querySelector('#groups .grp[data-wing="problems"]'); group?.focus(); return Boolean(group); })()`);
    await localPage.writeStatus({ [expected.truthContainer]: { running: true } });
    await sampleTruth();
    const railFocus = await focusState();
    if (!focusedGroup || railFocus.body || !railFocus.inRail || !railFocus.group) {
      round1Fail(`Recovery dropped keyboard focus from the Failures group: ${JSON.stringify({ focusedGroup, railFocus })}`);
    }
    await value("document.activeElement?.blur(); true");

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

    // HOSTD-83 gate r1 M1: a fresh artifact that lists none of the services is no proof
    // that anything runs, whatever the probes find. No green or split lens, no
    // "running" headline (only a real failure may still be loud).
    await localPage.writeStatus({});
    const unlisted = await sampleBoard();
    if (unlisted.truth !== "live" || unlisted.verdict === "ok" || ["on", "dim", "split"].includes(unlisted.lens) || unlisted.vouched ||
        (unlisted.verdict !== "bad" && /running/i.test(unlisted.headline))) {
      round1Fail(`Aggregate claimed more than the evidence (artifact lists no service): ${JSON.stringify(unlisted)}`);
    }

    // HOSTD-83 gate r1 M8: an artifact whose timestamp cannot age is not evidence.
    const badTimes = {};
    for (const [label, generated] of [["Infinity", "Infinity"], ["a day ahead", Math.floor(Date.now() / 1000) + 86400]]) {
      await localPage.writeStatus({ [expected.truthContainer]: { running: true } }, 0, {}, { generated });
      const card = await sampleTruth();
      const board = await sampleBoard();
      badTimes[label] = { card, board };
      if (card.truth !== "none" || card.hostTruth !== "absent" || card.led !== "off" || card.word ||
          board.truthLabel !== englishStrings.tr_unusable) {
        round1Fail(`Artifact with generated=${label} was trusted: ${JSON.stringify({ card, board })}`);
      }
    }
    await assertEvidence("artifact with an invalid timestamp");

    // HOSTD-83 gate r1 M3 + r2 M1: a job record is evidence on its own; a oneshot service
    // that finished cleanly ("inactive" between runs) is not a stopped daemon; but a timer
    // or socket that is inactive IS stopped, whatever its last run said.
    let jobStates = null;
    const base = { [expected.truthContainer]: { running: true } };
    const ago = sec => Math.floor(Date.now() / 1000) - sec;
    if (jobUnitService) {
      const jobName = englishOf(jobUnitService.name);
      await localPage.writeStatus(base, 0, {}, { jobs: { [jobUnitService.unit]: { ok: false, last: ago(3600) } } });
      const failedNoRow = await sampleCard(jobName);
      jobStates = { jobName, failedNoRow };
      if (failedNoRow.state !== "jobfail" || failedNoRow.led !== "bad" || failedNoRow.word !== englishStrings.jobFailed) {
        round1Fail(`A failed job without a unit row was ignored: ${JSON.stringify(jobStates)}`);
      }
    }
    if (timerService) {
      const name = englishOf(timerService.name);
      await localPage.writeStatus(base, 0, {}, {
        units: { [timerService.unit]: { running: false, active: "inactive", enabled: "disabled" } },
        jobs: { [timerService.unit]: { ok: true, last: ago(600) } },
      });
      const stoppedTimer = await sampleCard(name);
      jobStates = { ...jobStates, timer: { name, unit: timerService.unit, stoppedTimer } };
      if (stoppedTimer.state !== "stopped" || stoppedTimer.led !== "bad" || stoppedTimer.word !== englishStrings.status_stopped || !stoppedTimer.shown) {
        round1Fail(`A stopped ${timerService.unit} with an ok last run did not read Down: ${JSON.stringify(jobStates.timer)}`);
      }
    }
    if (oneshotService) {
      const name = englishOf(oneshotService.name);
      const inactive = async type => {
        await localPage.writeStatus(base, 0, {}, {
          units: { [oneshotService.unit]: { running: false, active: "inactive", enabled: "enabled", ...(type ? { type } : {}) } },
          jobs: { [oneshotService.unit]: { ok: true, last: ago(600) } },
        });
        return sampleCard(name);
      };
      const finished = await inactive("oneshot");
      const unidentified = await inactive(null);
      jobStates = { ...jobStates, oneshot: { name, unit: oneshotService.unit, finished, unidentified } };
      if (finished.state !== "jobok" || finished.led !== "on" || finished.word !== englishStrings.jobOk) {
        round1Fail(`A finished oneshot read as a stopped daemon: ${JSON.stringify(jobStates.oneshot)}`);
      }
      if (unidentified.state !== "stopped" || unidentified.led !== "bad") {
        round1Fail(`An inactive .service the host does not identify as a oneshot hid behind its last run: ${JSON.stringify(jobStates.oneshot)}`);
      }
    }

    // HOSTD-83 gate r1 M2: the path-only service's host binding says running, and this
    // dashboard's own server answers its path 404. That is a loud HTTP 404, not
    // "Unreachable" with the code thrown away.
    let pathOnlyRunning = null;
    if (pathOnlyConfig && (pathOnlyConfig.container || pathOnlyConfig.unit)) {
      await localPage.writeStatus(
        { [expected.truthContainer]: { running: true }, ...(pathOnlyConfig.container ? { [pathOnlyConfig.container]: { running: true } } : {}) },
        0, {}, pathOnlyConfig.unit ? { units: { [pathOnlyConfig.unit]: { running: true, active: "active", enabled: "enabled" } } } : {},
      );
      pathOnlyRunning = await sampleCard(expected.pathOnlyService);
      if (pathOnlyRunning.state !== "fault" || pathOnlyRunning.led !== "bad" || pathOnlyRunning.word !== "HTTP 404" || !pathOnlyRunning.shown) {
        round1Fail(`Running host + same-origin 404 did not read as HTTP 404: ${JSON.stringify(pathOnlyRunning)}`);
      }
    }

    // HOSTD-83 gate r1 M7: empty or malformed telemetry is not health.
    let selfReport = null;
    if (expected.selfReportCard) {
      selfReport = {};
      for (const [label, telemetry] of [["empty", {}], ["health null", { health: null }], ["health 1", { health: 1 }]]) {
        await localPage.writeStatus({ [expected.truthContainer]: { running: true } }, 0, {}, { extras: { [expected.selfReportKey]: telemetry } });
        const card = await sampleCard(expected.selfReportCard);
        selfReport[label] = card;
        if (card.led !== "off" || card.word || card.state !== "unknown") {
          round1Fail(`${expected.selfReportCard} telemetry ${label} read as a claim: ${JSON.stringify(card)}`);
        }
      }
      await localPage.writeStatus({ [expected.truthContainer]: { running: true } }, 0, {}, { extras: { [expected.selfReportKey]: { health: "OK", desired_volume: 40 } } });
      const healthy = await sampleCard(expected.selfReportCard);
      selfReport.ok = healthy;
      if (healthy.led !== "on" || healthy.word !== englishStrings.listening) {
        round1Fail(`${expected.selfReportCard} explicit OK no longer reads healthy: ${JSON.stringify(healthy)}`);
      }
    }
    await assertEvidence("round-1 fixtures");

    truthStates = { stopped, failureHelp, running, heroFocus, railFocus, stale, none, noneDe, unlisted, badTimes, jobStates, pathOnlyRunning, selfReport };
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

  // ── GATE ROUND 2 (HOSTD-83) ────────────────────────────────────────────────
  let round2 = null;
  if (truthCheck) {
    round2 = {};
    const now = () => Math.floor(Date.now() / 1000);
    const cardKey = name => value(`(() => { ${itemJs} return byName(${JSON.stringify(name)})?.dataset.item || null; })()`);
    // Every host binding the board shows, reported healthy: the base of a "healthy" board.
    const healthyFixture = async () => {
      const bindings = await value(`[...document.querySelectorAll("#services [data-item]")].map(item => ({
        container: item.dataset.container || null, unit: item.dataset.unit || null, extra: item.dataset.extra || null }))`);
      const fixture = { containers: {}, units: {}, extras: {} };
      for (const binding of bindings) {
        if (binding.container) fixture.containers[binding.container] = { running: true };
        if (binding.unit) fixture.units[binding.unit] = { running: true, active: "active", enabled: "enabled" };
        if (binding.extra) fixture.extras[binding.extra] = { health: "OK", desired_volume: 40 };
      }
      return fixture;
    };
    const writeFixture = (fixture, { http = {}, jobs = null, ageSec = 0 } = {}) =>
      localPage.writeStatus(fixture.containers, ageSec, http, { units: fixture.units, extras: fixture.extras, ...(jobs ? { jobs } : {}) });
    const visibleFocus = () => value(`(() => {
      const node = document.activeElement;
      return { body: !node || node === document.body, visible: Boolean(node && node !== document.body && node.isConnected && node.getClientRects().length),
        item: node?.closest?.("#services [data-item]")?.dataset.item || null, inRail: Boolean(node?.closest?.("#groups")), id: node?.id || null };
    })()`);
    const exceptionsBefore = exceptions.length;

    // r2 M4 — malformed host records are no evidence and never stop the other cards.
    // The hostile code belongs to the first host-bound service in sweep order, under a
    // valid running row so it is actually read: converting it used to throw and leave
    // every later card (the truth card, `laterService`) on its previous state, with an
    // unhandled exception in the console.
    if (hostileService) {
      const hostileName = englishOf(hostileService.name);
      const hostileKey = hostileService.httpKey || hostileService.container || hostileService.unit;
      const later = laterService ? englishOf(laterService.name) : null;
      await localPage.writeStatus({ [expected.truthContainer]: { running: true }, ...(laterService ? { [laterService.container]: { running: true } } : {}) });
      await sampleTruth();
      await localPage.writeStatus(
        {
          [expected.truthContainer]: { running: false },
          [expected.httpContainer]: { running: true },
          ...(hostileService.container ? { [hostileService.container]: { running: true } } : {}),
          ...(laterService ? { [laterService.container]: { running: false } } : {}),
        },
        0,
        { [hostileKey]: { code: { toString: null } }, [expected.httpContainer]: { code: null } },
        hostileService.unit && !hostileService.container ? { units: { [hostileService.unit]: { running: true, active: "active" } } } : {},
      );
      const truthAfter = await sampleTruth();
      const hostile = await sampleCard(hostileName);
      const nullCode = await sampleCard(expected.httpCard);
      const laterAfter = later ? await sampleCard(later) : null;
      round2.malformed = { hostileName, hostile, truthAfter, nullCode, later, laterAfter, newExceptions: exceptions.slice(exceptionsBefore) };
      if (truthAfter.state !== "stopped" || (laterAfter && laterAfter.state !== "stopped") || exceptions.length > exceptionsBefore) {
        round1Fail(`r2 M4: a hostile record stopped the other cards from updating: ${JSON.stringify(round2.malformed)}`);
      }
      if (["stopped", "fault"].includes(hostile.state) || hostile.word === englishStrings.status_stopped || /^HTTP|No answer/.test(hostile.word)) {
        round1Fail(`r2 M4: a hostile code became a verdict for ${hostileName}: ${JSON.stringify(hostile)}`);
      }
      if (nullCode.word === englishStrings.noAnswer || nullCode.led === "bad") {
        round1Fail(`r2 M4: an HTTP code of null read as curl's 0 ("No answer"): ${JSON.stringify(nullCode)}`);
      }
      // An empty running record for the truth card itself: no evidence, not Down.
      await localPage.writeStatus({ [expected.truthContainer]: {} });
      const emptyTruth = await sampleTruth();
      round2.malformed.emptyTruth = emptyTruth;
      if (emptyTruth.state === "stopped" || emptyTruth.led !== "off" || emptyTruth.word) {
        round1Fail(`r2 M4: an empty container record read as a verdict: ${JSON.stringify(emptyTruth)}`);
      }
      await assertEvidence("malformed host records");
    }

    // r2 M2 — the hero counts a finished job apart from running services. Every probe is
    // answered 200 here, so nothing but the evidence decides the verdict.
    if (oneshotService) {
      await controlProbes(() => "ok");
      const fixture = await healthyFixture();
      fixture.units[oneshotService.unit] = { running: false, active: "inactive", enabled: "enabled", type: "oneshot" };
      await writeFixture(fixture, { jobs: { [oneshotService.unit]: { ok: true, last: now() - 600 } } });
      await sampleCard(englishOf(oneshotService.name));
      const board = await sampleBoard();
      const counts = await value(`(() => {
        const items = [...document.querySelectorAll("#services [data-item]")];
        return { n: items.length, jobs: items.filter(item => item.dataset.s === "jobok").length,
          running: items.filter(item => ["on", "dim"].includes(item.dataset.l) && item.dataset.s !== "jobok").length };
      })()`);
      const want = board.verdict === "ok" ? fmt("h_okJobs", { n: counts.n, r: counts.running, j: counts.jobs })
        : board.verdict === "partial" ? fmt("h_partial", { ok: counts.running, n: counts.n }) : null;
      round2.jobsHeadline = { board, counts, want };
      if (counts.jobs !== 1 || !want || board.headline !== want || /All \d+ services running/.test(board.headline)) {
        round1Fail(`r2 M2: the hero counted a finished job as running: ${JSON.stringify(round2.jobsHeadline)}`);
      }
      await controlProbes(null);
    }

    // r2 M3 — an open recovery sheet follows its service: dismissed when the service
    // stops or recovers, re-worded when the host status expires. The service's own
    // probe is refused here (unreachable from this browser), everything else answers.
    {
      const name = expected.httpCard;
      const key = await cardKey(name);
      const probe = await value(`(() => { ${itemJs} return byName(${JSON.stringify(name)})?.dataset.probe || null; })()`);
      if (key && probe) {
        let refuse = true;
        await controlProbes(url => refuse && url.startsWith(probe) ? "fail" : "ok");
        const base = { [expected.truthContainer]: { running: true } };
        const up = { ...base, [expected.httpContainer]: { running: true } };
        const ok200 = { [expected.httpContainer]: { code: 200, ms: 9 } };
        const sheetState = () => value(`(() => {
          const sheet = document.getElementById("sheet");
          return { open: !sheet.hidden, led: sheet.querySelector(".led")?.dataset.l || null, word: sheet.querySelector(".sh-st")?.textContent.trim() || "",
            text: sheet.textContent.replace(/\\s+/g, " ").trim().slice(0, 400), focusInSheet: sheet.contains(document.activeElement) };
        })()`);
        const openIt = async () => {
          const card = await sampleCard(name);
          const clicked = await value(`(() => { ${itemJs} const item = byName(${JSON.stringify(name)});
            if (!item || !["split", "aring"].includes(item.dataset.l)) return false; linkOf(item).click(); return true; })()`);
          return { card, clicked, sheet: await sheetState() };
        };
        const hostWords = family ? englishStrings.shAwayHostF : englishStrings.shAwayHostO;
        await localPage.writeStatus(up, 0, ok200);
        const opened = await openIt();
        await localPage.writeStatus({ ...base, [expected.httpContainer]: { running: false } }, 0, ok200);
        const stoppedCard = await sampleCard(name);
        const afterStop = await sheetState();
        const focusAfterStop = await visibleFocus();
        await localPage.writeStatus(up, 0, ok200);
        const reopened = await openIt();
        await localPage.writeStatus(up, 600, ok200);
        const expiredCard = await sampleCard(name);
        const afterExpiry = await sheetState();
        refuse = false;
        await localPage.writeStatus(up, 0, ok200);
        const recoveredCard = await sampleCard(name);
        const afterRecovery = await sheetState();
        round2.sheet = { name, opened, stoppedCard, afterStop, focusAfterStop, reopened, expiredCard, afterExpiry, recoveredCard, afterRecovery };
        if (!opened.clicked || !opened.sheet.open || opened.sheet.led !== "split" || !opened.sheet.text.includes(hostWords)) {
          throw new Error(`Recovery sheet did not open for a host-confirmed unreachable ${name}: ${JSON.stringify(opened)}`);
        }
        if (stoppedCard.state !== "stopped" || afterStop.open) {
          round1Fail(`r2 M3: the recovery sheet kept claiming "running per host" after ${name} stopped: ${JSON.stringify({ stoppedCard, afterStop })}`);
        }
        if (focusAfterStop.body || !focusAfterStop.visible) {
          round1Fail(`r2 M3: dismissing the sheet dropped keyboard focus: ${JSON.stringify(focusAfterStop)}`);
        }
        if (!reopened.sheet.open || expiredCard.led !== "aring" || !afterExpiry.open || afterExpiry.led !== "aring" ||
            !afterExpiry.text.includes(englishStrings.shAwayOnly) || afterExpiry.text.includes(hostWords)) {
          round1Fail(`r2 M3: the recovery sheet kept the host's word after the status file expired: ${JSON.stringify({ reopened, expiredCard, afterExpiry })}`);
        }
        if (!["up", "running"].includes(recoveredCard.state) || afterRecovery.open) {
          round1Fail(`r2 M3: the recovery sheet stayed open after ${name} recovered: ${JSON.stringify({ recoveredCard, afterRecovery })}`);
        }
        await value(`(() => { document.getElementById("sheet").hidden || document.querySelector('#sheet [data-act="close"]')?.click(); document.activeElement?.blur(); return true; })()`);
        await controlProbes(null);
      }
    }

    // r2 L1 — focus survives a PARTIAL recovery under the Failures filter: two failures,
    // the focused one recovers, the filter stays, and its row disappears. Focus must land
    // on something visible (the other failure, or a stable control), never <body>.
    {
      const truthKey = await cardKey(expected.truthCard);
      const twoFailures = { [expected.truthContainer]: { running: false }, [expected.httpContainer]: { running: true } };
      const oneFailure = { [expected.truthContainer]: { running: true }, [expected.httpContainer]: { running: true } };
      const http503 = { [expected.httpContainer]: { code: 503, ms: 9 } };
      const recoverFrom = async focusJs => {
        await localPage.writeStatus(twoFailures, 0, http503);
        await sampleTruth();
        const focused = await value(`(() => {
          const problems = document.querySelector('#groups .grp[data-wing="problems"]');
          if (problems && problems.getAttribute("aria-pressed") !== "true") problems.click();
          const target = (${focusJs})();
          target?.focus();
          return { focused: Boolean(target) && document.activeElement === target, filter: document.querySelector('#groups .grp[aria-pressed="true"]')?.dataset.wing || null };
        })()`);
        await localPage.writeStatus(oneFailure, 0, http503);
        await sampleTruth();
        return { ...focused, after: await visibleFocus(),
          filterAfter: await value(`document.querySelector('#groups .grp[aria-pressed="true"]')?.dataset.wing || null`) };
      };
      const row = await recoverFrom(`() => { ${itemJs} const item = items().find(node => node.dataset.item === ${JSON.stringify(truthKey)}); return item ? (item.matches("a,[tabindex]") ? item : item.querySelector("a,[tabindex]")) : null; }`);
      const chip = family ? null : await recoverFrom(`() => document.querySelector('#hero .att-chip[data-key="' + ${JSON.stringify(truthKey)} + '"]')`);
      round2.partialRecovery = { row, chip };
      for (const [label, state] of [["its row", row], ["its attention chip", chip]]) {
        if (!state) continue;
        if (!state.focused || state.filter !== "problems" || state.filterAfter !== "problems") {
          throw new Error(`Partial-recovery fixture did not hold (${label}): ${JSON.stringify(state)}`);
        }
        if (state.after.body || !state.after.visible || state.after.item === truthKey) {
          round1Fail(`r2 L1: a partial recovery under Failures dropped focus from ${label}: ${JSON.stringify(state)}`);
        }
      }
      await value(`(() => { document.querySelector('#groups .grp[data-wing="all"]')?.click(); document.activeElement?.blur(); return true; })()`);
      await localPage.writeStatus({ [expected.truthContainer]: { running: true } });
      await sampleTruth();
    }

    // ── GATE ROUND 3 (HOSTD-83): every sentence claims only what its evidence holds ──
    // The real page on this board's own audience (family or operator), read in English
    // AND German, every probe answered here. Expected sentences come from the page's own
    // STRINGS; a key the page lacks reads «no key» and cannot match. scripts/
    // test-claims.mjs covers the same rules for both audiences on every board without a
    // browser; this proves the page itself says them.
    {
      const say = (lang, key, vars = {}) => (allStrings[lang]?.[key] ?? `«no ${key}»`).replace(/\{(\w+)\}/g, (match, name) => vars[name] ?? match);
      const NOT_RUNNING = { en: /not running/i, de: /l(a|ä)uf(t|en) (gerade )?nicht\b/i };
      const CAUSES = /broken, not the service|only this device|gestört, nicht der Dienst|nur dieses Gerät/i;
      const pathOnlyKey = expected.pathOnlyService ? await cardKey(expected.pathOnlyService) : null;
      const cards = await value(`[...document.querySelectorAll("#services [data-item]")].map(item => ({
        key: item.dataset.item, container: item.dataset.container || null, unit: item.dataset.unit || null, probe: item.dataset.probe || null }))`);
      const bound = cards.filter(card => card.container || card.unit);
      const containers = bound.filter(card => card.container && card.key !== pathOnlyKey);
      const recordKey = card => card.container || card.unit;
      // Cards whose row says running in this fixture (hostEntry reads the container first).
      const runningRows = fixture => cards.filter(card => card.container ? fixture.containers[card.container]?.running === true
        : card.unit ? fixture.units[card.unit]?.running === true : false).length;
      const contact = englishOf(hostConfig.contact?.name) || "";
      const readHero = () => value(`(() => ({
        lang: document.documentElement.lang, verdict: document.documentElement.dataset.v || null,
        headline: document.getElementById("heroH")?.textContent || "",
        sub: document.querySelector("#hero .hero-sub")?.textContent || "",
        guide: [...document.querySelectorAll("#hero .guide li")].map(li => li.textContent),
        chips: [...document.querySelectorAll("#hero .att-chip .badge")].map(node => node.textContent),
        names: Object.fromEntries([...document.querySelectorAll("#services [data-item]")].map(node => [node.dataset.item, node.querySelector("[data-name]")?.dataset.name || ""])),
        labels: Object.fromEntries([...document.querySelectorAll("#services [data-item]")].map(node => [node.dataset.item,
          node.getAttribute("aria-label") || node.querySelector(".row")?.getAttribute("aria-label") || ""])),
        sheet: document.getElementById("sheet").hidden ? null : document.getElementById("sheet").textContent.replace(/\\s+/g, " ").trim(),
      }))()`);
      const inBoth = async () => {
        const out = {};
        for (const lang of ["en", "de"]) {
          await value(`document.querySelector('[data-language="${lang}"]').click()`);
          out[lang] = await readHero();
        }
        await value(`document.querySelector('[data-language="en"]').click()`);
        return out;
      };
      const run = async (change, { http = {}, jobs = null, policy = () => "ok" } = {}) => {
        await controlProbes(policy);
        const fixture = await healthyFixture();
        change(fixture);
        await writeFixture(fixture, { http, jobs });
        await sampleBoard();
        return { fixture, said: await inBoth() };
      };
      const claims = {};
      const expectEach = (label, said, test) => {
        for (const lang of ["en", "de"]) {
          const hero = said[lang];
          const problem = test(lang, hero);
          const text = [hero.headline, hero.sub, ...hero.guide, hero.sheet || ""].join(" | ");
          if (problem) round1Fail(`r3 ${label} (${family ? "family" : "operator"}, ${lang}): ${problem}: ${JSON.stringify({ headline: hero.headline, sub: hero.sub, guide: hero.guide, chips: hero.chips, sheet: hero.sheet })}`);
          if (CAUSES.test(text)) round1Fail(`r3 ${label}, cause named (${family ? "family" : "operator"}, ${lang}): a sentence names a cause for "unreachable": ${text}`);
        }
      };
      const n = cards.length;

      // M1 — two HTTP 503 under running containers: faults, not "not running", and the
      // running count counts the running rows (the faulted ones included).
      if (containers.length >= 2) {
        const [a, b] = containers;
        const { fixture, said } = await run(() => {}, { http: { [recordKey(a)]: { code: 503 }, [recordKey(b)]: { code: 503 } } });
        claims.twoFaults = said;
        const r = runningRows(fixture);
        expectEach("M1 two HTTP 503 under running containers", said, (lang, hero) => {
          if (family) {
            if (hero.headline !== say(lang, "h_badManyFault", { b: 2 })) return "headline is not the fault count";
            if (!hero.sub.startsWith(say(lang, "s_badF", { r, n }))) return `subline does not count ${r} running rows`;
            if (NOT_RUNNING[lang].test([hero.headline, hero.sub, ...hero.guide].join(" "))) return 'says "not running"';
          } else if (hero.headline !== say(lang, "h_badOp", { b: 2, n }) || hero.chips.filter(chip => chip === "HTTP 503").length !== 2) return "headline or chips do not name the two faults";
          return null;
        });
      }

      // M1 — failed jobs under running units (or containers): faults, still running.
      if (bound.length >= 2) {
        const pair = [...bound.filter(card => card.unit && !card.container), ...bound.filter(card => card.container)].slice(0, 2);
        const { fixture, said } = await run(() => {}, { jobs: Object.fromEntries(pair.map(card => [card.unit || card.container, { ok: false, last: now() - 3600 }])) });
        claims.failedJobs = said;
        const r = runningRows(fixture);
        expectEach("M1 failed jobs under running units", said, (lang, hero) => {
          if (family) {
            if (hero.headline !== say(lang, "h_badManyFault", { b: 2 })) return "headline is not the fault count";
            if (!hero.sub.startsWith(say(lang, "s_badF", { r, n }))) return `subline does not count ${r} running rows`;
          } else if (hero.headline !== say(lang, "h_badOp", { b: 2, n })) return "headline does not count the two failed runs";
          return null;
        });
      }

      // M1 — one stopped plus one fault: counted apart.
      if (containers.length >= 2) {
        const [a, b] = containers;
        const { fixture, said } = await run(f => { f.containers[a.container] = { running: false }; }, { http: { [recordKey(b)]: { code: 503 } } });
        claims.stoppedAndFault = said;
        const r = runningRows(fixture);
        expectEach("M1 one stopped plus one fault", said, (lang, hero) => {
          if (family) {
            if (hero.headline !== say(lang, "h_badMix", { b: 2, s: 1, f: 1 })) return "headline does not count stopped and fault apart";
            if (!hero.sub.startsWith(say(lang, "s_badF", { r, n }))) return `subline does not count ${r} running rows`;
          } else if (hero.headline !== say(lang, "h_badOp", { b: 2, n })) return "headline does not count both";
          return null;
        });
      }

      // M2 — a running row, no host HTTP measurement, a failed probe: running per host and
      // unreachable from this browser, and nothing about where it fails.
      const target = cards.find(card => card.probe && (card.container || card.unit) && card.key !== pathOnlyKey);
      if (target) {
        const policy = url => url.startsWith(target.probe) ? "fail" : "ok";
        const { said } = await run(() => {}, { policy });
        await value(`(() => { const item = document.querySelector('#services [data-item="${target.key}"]'); (item.matches("a") ? item : item.querySelector("a"))?.click(); return true; })()`);
        const withSheet = await inBoth();
        await value(`(() => { document.querySelector('#sheet [data-act="close"]')?.click(); document.activeElement?.blur(); return true; })()`);
        claims.unreachable = { said, withSheet };
        expectEach("M2 running row, no host HTTP, failed probe", said, (lang, hero) => {
          const name = hero.names[target.key];
          if (family) {
            if (hero.headline !== say(lang, "h_away1", { name }) || hero.sub !== say(lang, "s_awayHostF")) return "headline/subline say more than running per host and unreachable";
            const steps = [say(lang, "g_retry"), say(lang, "g_wifi"), contact ? say(lang, "g_still", { name: contact }) : say(lang, "g_stillNeutral")];
            if (JSON.stringify(hero.guide) !== JSON.stringify(steps)) return "guidance differs";
          } else if (hero.headline !== say(lang, "h_awayOp1", { name }) || hero.sub !== say(lang, "s_awayHostO")) return "headline/subline say more than running per host and unreachable";
          const heard = say(lang, "srState", { word: say(lang, "status_unreachable"), src: say(lang, "src_split") });
          if (!hero.labels[target.key].includes(heard)) return `the screen reader does not hear "${heard}"`;
          return null;
        });
        expectEach("M2 recovery sheet, no host HTTP", withSheet, (lang, hero) => {
          if (!hero.sheet) return "the sheet did not open";
          if (family) return hero.sheet.includes(say(lang, "shAwayHostF")) ? null : "family sheet wording differs";
          if (!hero.sheet.includes(say(lang, "shAwayHostO")) || !hero.sheet.includes(say(lang, "shAwayOpsHost")) ||
              hero.sheet.includes(say(lang, "shHostOk", { code: "" }).replace(/\s*\.$/, ""))) return "operator sheet claims a host answer it does not have, or skips the service check";
          return null;
        });
      }

      // M1 — mixed counts: running services, a finished job, a fault.
      const job = (oneshotService && cards.find(card => card.unit === oneshotService.unit && !card.container))
        || cards.find(card => card.key !== containers[0]?.key && (card.container || card.unit) && card.key !== pathOnlyKey && !card.probe);
      if (job && containers.length) {
        const fault = containers.find(card => card.key !== job.key);
        const oneshot = Boolean(oneshotService && job.unit === oneshotService.unit && !job.container);
        const { fixture, said } = await run(f => {
          if (oneshot) f.units[job.unit] = { running: false, active: "inactive", enabled: "enabled", type: "oneshot" };
          else if (job.container) delete f.containers[job.container];
          else delete f.units[job.unit];
        }, { http: { [recordKey(fault)]: { code: 503 } }, jobs: { [job.unit && !job.container ? job.unit : job.container]: { ok: true, last: now() - 600 } } });
        claims.mixed = said;
        const r = runningRows(fixture);
        expectEach("M1 mixed running, finished job and fault", said, (lang, hero) => {
          if (family) {
            if (hero.headline !== say(lang, "h_bad1Fault", { name: hero.names[fault.key], word: "HTTP 503" })) return "headline does not name the fault";
            if (!hero.sub.startsWith(`${say(lang, "s_badF", { r, n })} ${say(lang, "s_jobs", { list: hero.names[job.key] })}`)) return `subline does not count ${r} running and the job apart`;
          } else if (hero.headline !== say(lang, "h_badOp", { b: 1, n })) return "headline does not count the one fault";
          return null;
        });
      }
      round2.claims = claims;
      await controlProbes(null);
      await localPage.writeStatus({ [expected.truthContainer]: { running: true } });
      await sampleTruth();
    }
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
  // A view transition the browser skips (here: a second switch in the same tick; on
  // a real tablet also a hidden tab) still applies the update and must not surface as
  // an unhandled rejection. Seen once locally on hsb8 as "Transition was aborted ...
  // Document hidden" from the switch above.
  const exceptionsBeforeSkip = exceptions.length;
  await value(`(() => {
    const button = document.querySelector('[data-density="' + ${JSON.stringify(densityState.other)} + '"]');
    button.click();
    button.click();
    return true;
  })()`);
  await sleep(600);
  const skippedTransition = {
    density: await value("document.documentElement.dataset.density"),
    newExceptions: exceptions.slice(exceptionsBeforeSkip),
  };
  await value(`document.querySelector('[data-density="${expected.density}"]').click(); true`);
  await sleep(400);
  if (skippedTransition.density !== densityState.other || skippedTransition.newExceptions.length) {
    throw new Error(`A skipped view transition surfaced as an error or lost the switch: ${JSON.stringify(skippedTransition)}`);
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
  // HOSTD-83 gate r1 L2: with storage blocked (every method throws) and a light system
  // appearance, each click still flips the theme. It used to go light → dark → dark.
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  const blockedTheme = await value(`(() => {
    const proto = Storage.prototype;
    const saved = { getItem: proto.getItem, setItem: proto.setItem, removeItem: proto.removeItem };
    for (const name of Object.keys(saved)) proto[name] = () => { throw new DOMException("blocked", "SecurityError"); };
    try {
      const seen = [document.documentElement.dataset.theme];
      for (let i = 0; i < 3; i += 1) {
        document.getElementById("themeSwitch").click();
        seen.push(document.documentElement.dataset.theme);
      }
      return seen;
    } finally {
      Object.assign(proto, saved);
    }
  })()`);
  if (blockedTheme.some((theme, i) => i && theme === blockedTheme[i - 1])) {
    round1Fail(`Theme switch stuck while storage is blocked: ${JSON.stringify(blockedTheme)}`);
  }
  await value(`(() => { if (document.documentElement.dataset.theme !== ${JSON.stringify(themeState.before)}) document.getElementById("themeSwitch").click(); return true; })()`);
  await send("Emulation.setEmulatedMedia", { features: [] });

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

  // ── GATE ROUND 2, after reloads (HOSTD-83) ──────────────────────────────────
  // Reload and wait until the board is up with live host truth; `cards` is how many
  // services it must show, `source` where they must come from.
  const reloadUntil = async ({ cards = expected.cards, source = expected.configSource, verdict = true, timeoutMs = 9000 } = {}) => {
    await value("window.__r2Reload = true");
    const started = Date.now();
    // ignoreCache: the probe-wording checks rewrite config.js between reloads.
    await send("Page.reload", { ignoreCache: true });
    while (Date.now() - started < timeoutMs) {
      try {
        if (await value(`!window.__r2Reload && document.querySelectorAll("#services [data-item]").length === ${cards} &&
            document.documentElement.dataset.configSource === ${JSON.stringify(source)} &&
            document.documentElement.dataset.truth === "live" && ${verdict ? 'document.documentElement.dataset.v !== "checking"' : "true"}`)) {
          return Date.now() - started;
        }
      } catch (error) {
        if (!/Execution context was destroyed|Cannot find context/.test(error.message)) throw error;
      }
      await sleep(50);
    }
    return null;
  };
  const heroWords = () => value(`(() => ({
    verdict: document.documentElement.dataset.v || null,
    sub: document.querySelector("#hero .hero-sub")?.textContent || "",
    guide: document.querySelector("#hero .guide")?.textContent || "",
    busy: document.querySelectorAll('#services [data-item][aria-busy="true"]').length,
    probed: document.querySelectorAll('#services [data-item][data-probed="1"]').length,
  }))()`);
  // What a family board may only say with this browser's own reachability evidence,
  // and what it says on the host's word alone (EN, the language the smoke runs in).
  const tail = key => (englishStrings[key] ?? key).replace("{list}", "");
  const opensWords = ["s_okFOne", "s_okFMany", "g_othersOne", "g_othersMany", "g_allOpen"].map(key => key === "g_allOpen" ? englishStrings[key] : tail(key));
  const saysOpens = text => opensWords.some(words => text.includes(words));

  // r2 M5 — family guidance claims "opens"/"works" only on reachability evidence. With
  // every probe still pending (held unanswered) or disabled in the config, the board has
  // the host's word only, and says so.
  if (truthCheck && family) {
    const healthy = await (async () => {
      const bindings = await value(`[...document.querySelectorAll("#services [data-item]")].map(item => ({ container: item.dataset.container || null, unit: item.dataset.unit || null }))`);
      const containers = {}, units = {};
      for (const binding of bindings) {
        if (binding.container) containers[binding.container] = { running: true };
        if (binding.unit) units[binding.unit] = { running: true, active: "active", enabled: "enabled" };
      }
      return { containers, units };
    })();
    const writeHealthy = (changes = {}) => localPage.writeStatus({ ...healthy.containers, ...changes }, 0, {}, { units: healthy.units });
    const wording = {};

    await writeHealthy();
    await controlProbes(() => "hold");
    wording.pendingLoad = await reloadUntil();
    wording.pending = await heroWords();
    await releaseHeld("ok");
    await controlProbes(() => "ok");
    const deadline = Date.now() + 6000;
    wording.reached = await heroWords();
    while (!saysOpens(wording.reached.sub) && Date.now() < deadline) {
      await sleep(150);
      wording.reached = await heroWords();
    }

    await writeHealthy({ [expected.truthContainer]: { running: false } });
    await controlProbes(() => "hold");
    wording.failureLoad = await reloadUntil();
    wording.failurePending = await heroWords();
    await controlProbes(null);

    await localPage.setProbeDisabled(true);
    await writeHealthy();
    wording.disabledLoad = await reloadUntil();
    await sleep(sweepMs);
    wording.disabled = await heroWords();
    await localPage.setProbeDisabled(false);
    round2 = { ...round2, wording };

    if (!wording.pendingLoad || wording.pending.verdict !== "ok" || !wording.pending.busy || wording.pending.probed) {
      throw new Error(`Pending-probe fixture did not hold: ${JSON.stringify(wording)}`);
    }
    if (saysOpens(wording.pending.sub) || !wording.pending.sub.includes(tail("s_runFOne").trim()) && !wording.pending.sub.includes(tail("s_runFMany").trim())) {
      round1Fail(`r2 M5: with every probe pending the board said a service opens: ${JSON.stringify(wording.pending)}`);
    }
    if (!saysOpens(wording.reached.sub)) {
      round1Fail(`r2 M5: once this browser reached the services, the board did not say they open: ${JSON.stringify(wording.reached)}`);
    }
    if (!wording.failureLoad || wording.failurePending.verdict !== "bad" || !wording.failurePending.guide ||
        saysOpens(wording.failurePending.guide) || !wording.failurePending.guide.includes(tail("g_runOne").trim()) && !wording.failurePending.guide.includes(tail("g_runMany").trim())) {
      round1Fail(`r2 M5: on a failure with every probe pending, the guidance said the others open as usual: ${JSON.stringify(wording.failurePending)}`);
    }
    if (!wording.disabledLoad || wording.disabled.verdict !== "ok" || wording.disabled.probed || saysOpens(wording.disabled.sub)) {
      round1Fail(`r2 M5: with the browser check disabled in the config, the board said a service opens: ${JSON.stringify(wording.disabled)}`);
    }
    // Back to the board as configured.
    if (!(await reloadUntil({ verdict: false }))) throw new Error("Board did not come back after the probe-wording checks");
  }

  // r2 M6 — the optional manifest is bounded: a manifest that never answers, or sends
  // half a body and stalls, must not keep the board from starting on its config.js.
  if (localPage) {
    const fallbackCards = defaults[host]?.cards || defaults.hsb1.cards;
    const stalls = {};
    for (const mode of ["hang", "body"]) {
      localPage.setManifest(mode);
      const ms = await reloadUntil({ cards: fallbackCards, source: "config-js", verdict: false, timeoutMs: 12000 });
      stalls[mode] = { ms, cards: await value(`document.querySelectorAll("#services [data-item]").length`), source: await value("document.documentElement.dataset.configSource || null") };
    }
    localPage.setManifest("normal");
    round2 = { ...round2, stalls };
    for (const [mode, stall] of Object.entries(stalls)) {
      if (!stall.ms || stall.ms > 8000) {
        round1Fail(`r2 M6: a stalled manifest (${mode}) kept the board from starting on config.js: ${JSON.stringify(stall)}`);
      }
    }
    if (!(await reloadUntil({ verdict: false }))) throw new Error("Board did not come back after the manifest-stall checks");
  }

  if (softFailures.length) {
    throw new Error(`Gate checks failed (${softFailures.length}):\n  ✗ ${softFailures.join("\n  ✗ ")}`);
  }
  if (exceptions.length) {
    throw new Error(`Runtime exceptions: ${exceptions.join("; ")}`);
  }
  if (foreignResources.length) {
    throw new Error(`The page loaded resources from elsewhere: ${foreignResources.join("; ")}`);
  }

  console.log(
    JSON.stringify({ host, pageUrl, initial, pathOnlySample, truthStates, httpStates, round2, mobileLayout, densityState, themeState, blockedTheme,
      searchState, firstEscape, escapeState, defaultLanguage, fallbackLanguage, persistedLanguage, retainedState,
      localizedSearch, sharedLanguage }, null, 2),
  );
  await send("Browser.close").catch(() => {});
} finally {
  await cleanup();
}
