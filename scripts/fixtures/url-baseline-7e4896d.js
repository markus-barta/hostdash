// FROZEN BASELINE for scripts/url-sweep.mjs (HOSTD-83 gate r4). Never edit.
//
// What it is: the link/probe resolution of the pre-rewrite board, copied verbatim from
//   commit 7e4896dcedbe083db8aa96e82587e4da28c2c8cd (main before PR #30; its merge base)
//   file   public/index.html
//   lines  1016, 1018-1023  isObject, objectOr, arrayOrEmpty, stringOr, isLocalizable, localizedOr
//          1049-1090        cleanServices
//          1435-1449        serviceTargetUrl
//          1377, 1392-1399  the render loop's link/probe decision (in baseDecision below)
//
// Why a copy: the sweep compared against origin/main, which is this PR's own page once
// it merges; it then failed for every later run. A commit is immutable, a copy needs no
// git history and runs in a shallow checkout. scripts/test-url-sweep.mjs proves each
// function here byte-identical to its definition in that commit (and the decision lines
// present there, in order) whenever the commit object is available; CI fetches it by SHA.
//
// Runs in a VM with `window.location` and `URL` provided by the sweep.

const isObject = value => value && typeof value === "object" && !Array.isArray(value);
const objectOr = value => isObject(value) ? value : {};
const arrayOrEmpty = value => Array.isArray(value) ? value : [];
const stringOr = (value, fallback = "") => typeof value === "string" ? value : fallback;
const isLocalizable = value => typeof value === "string" ||
  (isObject(value) && Object.values(value).some(item => typeof item === "string"));
const localizedOr = (value, fallback = "") => isLocalizable(value) ? value : fallback;

function cleanServices(services) {
  return arrayOrEmpty(services)
    .filter(service => isObject(service) && typeof service.wing === "string" && isLocalizable(service.name))
    .map(service => {
      const rawStatusPolicy = objectOr(service.statusPolicy);
      const statusPolicy = {
        source: stringOr(rawStatusPolicy.source, "hostdash-probe"),
        ...(typeof rawStatusPolicy.staticState === "string" ? { staticState: rawStatusPolicy.staticState } : {}),
      };
      const status = typeof service.status === "string"
        ? service.status
        : statusPolicy.staticState || null;
      const url = typeof service.url === "string" ? service.url : null;
      const probe = typeof service.probe === "boolean" || typeof service.probe === "string"
        ? service.probe
        : null;
      return {
        wing: service.wing,
        name: service.name,
        purpose: localizedOr(service.purpose),
        icon: stringOr(service.icon, "server"),
        urls: objectOr(service.urls),
        sameHost: service.sameHost === true,
        passive: service.passive === true,
        certIssue: service.certIssue === true,
        statusPolicy,
        ...(url ? { url } : {}),
        ...(typeof service.container === "string" ? { container: service.container } : {}),
        ...(typeof service.unit === "string" ? { unit: service.unit } : {}),
        ...(typeof service.extra === "string" ? { extra: service.extra } : {}),
        ...(typeof service.scheme === "string" ? { scheme: service.scheme } : {}),
        ...(typeof service.port === "string" ? { port: service.port } : {}),
        ...(typeof service.hostPort === "string" ? { hostPort: service.hostPort } : {}),
        ...(typeof service.path === "string" ? { path: service.path } : {}),
        ...(typeof service.search === "string" ? { search: service.search } : {}),
        ...(isLocalizable(service.foot) ? { foot: service.foot } : {}),
        ...(status ? { status } : {}),
        ...(probe !== null ? { probe } : {}),
        ...(isLocalizable(service.note) ? { note: service.note } : {}),
      };
    });
}

function serviceTargetUrl(service) {
  if (!service.sameHost || !/^https?:$/.test(window.location.protocol) || !window.location.hostname) {
    return service.url;
  }

  const target = new URL(window.location.href);
  target.protocol = service.scheme || target.protocol;
  // A path-only service (no port) lives on this dashboard's own server: keep its port.
  const port = String(service.hostPort || service.port || "").replace(/^:/, "").split(/\s+/)[0];
  if (/^\d+$/.test(port)) target.port = port;
  target.pathname = service.path || "/";
  target.search = service.search || "";
  target.hash = "";
  return target.href;
}

// The render loop (lines 1376-1400) decides link and probe in these lines. Between the
// markers every line is verbatim and in the commit's order, indentation aside; left out
// are card.target and card.rel (lines 1395-1396), which decide neither. `card` stands in
// for the <a>: the sweep resolves what is assigned to `href` and `dataset.probe` the way
// the browser does.
function baseDecision(service, card) {
  // <verbatim>
  const active = !service.passive;
  if (active) {
    const targetUrl = serviceTargetUrl(service);
    card.href = targetUrl;
    if (service.status) card.dataset.staticState = service.status;
    else if (service.probe === false) card.dataset.staticState = "external";
    else card.dataset.probe = targetUrl;
  // </verbatim>
  }
  return card;
}
