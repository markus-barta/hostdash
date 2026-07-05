#!/usr/bin/env node
import { spawn } from "node:child_process";
import { copyFile, cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const browserPath =
  process.env.BROWSER_PATH || "/Applications/Helium.app/Contents/MacOS/Helium";
const port = Number(process.env.CDP_PORT || 9349);
const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const host = process.env.HOSTDASH_HOST || "hsb1";
const defaults = {
  hsb0: {
    cards: 11,
    total: 4,
    searchName: "AdGuard Home",
    searchTerm: "adguard",
    certService: "OpenClaw Gateway",
    sameHostService: "AdGuard Home",
    sameHostPort: "3000",
    sameHostPath: "/",
  },
  hsb1: {
    cards: 19,
    total: 10,
    searchName: "Plex",
    searchTerm: "plex",
    certService: "Scrypted",
    sameHostService: "Plex",
    sameHostPort: "32400",
    sameHostPath: "/web",
  },
  hsb8: {
    cards: 6,
    total: 2,
    searchName: "Home Assistant",
    searchTerm: "assistant",
    certService: null,
    sameHostService: "Home Assistant",
    sameHostPort: "8123",
    sameHostPath: "/",
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
  },
  csb0: {
    cards: 12,
    total: 5,
    searchName: "Node-RED",
    searchTerm: "node-red",
    certService: null,
    sameHostService: null,
    sameHostPort: null,
    sameHostPath: null,
  },
  csb1: {
    cards: 28,
    total: 15,
    searchName: "Docmost",
    searchTerm: "knowledge",
    certService: null,
    sameHostService: null,
    sameHostPort: null,
    sameHostPath: null,
  },
};
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
};

async function localPageUrl() {
  const site = await mkdtemp(join(tmpdir(), "hostdash-site-"));
  await cp(join(repoRoot, "public"), site, { recursive: true });
  await copyFile(join(repoRoot, "hosts", host, "config.js"), join(site, "config.js"));
  return {
    url: pathToFileURL(join(site, "index.html")).href,
    cleanup: () => rm(site, { recursive: true, force: true }),
  };
}

const localPage = process.env.PAGE_URL ? null : await localPageUrl();
const pageUrl = process.env.PAGE_URL || localPage.url;

const profile = await mkdtemp(join(tmpdir(), "hostdash-smoke-"));
const browser = spawn(browserPath, [
  "--headless=new",
  "--disable-gpu",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  "about:blank",
]);

browser.stdout.resume();
browser.stderr.resume();

async function cleanup() {
  browser.kill("SIGTERM");
  await new Promise(resolve => setTimeout(resolve, 150));
  await rm(profile, { recursive: true, force: true });
  await localPage?.cleanup();
}

async function waitForJson(path) {
  const url = `http://127.0.0.1:${port}${path}`;
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
  await send("Page.navigate", { url: pageUrl });
  await new Promise(resolve => setTimeout(resolve, 2500));

  const initial = await value(`(() => {
    const certName = ${JSON.stringify(expected.certService)};
    const sameHostName = ${JSON.stringify(expected.sameHostService)};
    const sameHostCard = sameHostName ? [...document.querySelectorAll(".svc")]
      .find(card => card.querySelector("h3")?.textContent === sameHostName) : null;
    return {
    cards: document.querySelectorAll(".svc").length,
    total: document.getElementById("totCount").textContent,
    online: document.getElementById("onCount").textContent,
    search: document.getElementById("q")?.id,
    zoom: document.getElementById("zoomRange")?.value,
    controlsInSidebar: Boolean(
      document.querySelector(".side .controls #q") &&
      document.querySelector(".side .controls #zoomRange") &&
      document.querySelector(".side .controls #zoomFit") &&
      document.querySelector(".side .controls #zoomReset")
    ),
    controlsInTopbar: Boolean(document.querySelector(".topbar #q, .topbar #zoomRange")),
    zoomNestedInSearch: Boolean(document.querySelector("label.search .zoom")),
    certState: certName ? [...document.querySelectorAll(".svc")]
      .find(card => card.querySelector("h3")?.textContent === certName)
      ?.querySelector(".state")?.dataset.s
      : null,
    sameHostHref: sameHostCard?.href || null
    };
  })()`);

  if (initial.cards !== expected.cards) {
    throw new Error(`Expected ${expected.cards} service cards, got ${JSON.stringify(initial)}`);
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
  if (expected.certService && initial.certState !== "cert") {
    throw new Error(`Expected ${expected.certService} TLS-cert state, got ${JSON.stringify(initial)}`);
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

  console.log(JSON.stringify({ host, pageUrl, initial, searchState, escapeState }, null, 2));
  await send("Browser.close").catch(() => {});
} finally {
  await cleanup();
}
