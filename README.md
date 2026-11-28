# HostDash

Static service dashboards for fleet hosts, served as immutable Nix package
outputs and mounted into small nginx containers.

Canonical repo: `github.com/markus-barta/hostdash`.

The shared app lives in `public/`. Host-specific service lists and metadata live
in `hosts/<host>/config.js`; package outputs copy the shared app plus the chosen
host config as `config.js`.

Host-local services should set `sameHost: true` and keep their canonical `.lan`
URL as `url`. At runtime the app rewrites the service link/probe to the hostname
used for the dashboard itself, so `http://hsb8.lan/`, `http://192.168.1.100/`,
and `http://100.64.0.3/` probe `:8123` on the matching address instead of
hardcoding one network. The `url` is the fallback for `file://` and other
non-HTTP origins; served over HTTP, `sameHost` with `port`/`path` alone resolves.

A service served by the dashboard's own nginx declares `path` and no `port`
(hsb0's hausnetz at `/ops/`, In flight at `/inflight/`). It keeps the
dashboard's own origin, port included. Its probe is same-origin and so readable,
and the code is kept: a `404` or `5xx` from that nginx is a measured failure
(`HTTP 502` in red when the host says the service runs, `Down` when the host says
nothing); a `401`/`403` is that server refusing this browser (hausnetz is
LAN-only), so it reads `Unreachable` with the code in its evidence, never as online.

## Board

Every board (csb0, csb1, hsb0, hsb1, hsb8, hsb9) renders the same page: the host
header with a live clock, a hero that states the overall state first, a group rail
(search, groups with counts, size), and the services as **Tiles** or a grouped
**List**. Light and dark follow the system until the header switch is used.

Each status is a small glass LED, and the rule is: **no evidence, no claim**.

| LED | Meaning | Source |
| --- | --- | --- |
| lit green | running | the host's `status.json` (or a service's own self-report) |
| green ring, dark core | reachable from this browser, the host says nothing | browser probe only |
| green core, amber ring | running per host, but this device cannot get through | host + failed probe |
| amber ring, dark core | this browser cannot get through, the host says nothing | failed probe only |
| lit red | a failure was measured: stopped, host-side HTTP 5xx or no answer, a failed job run, a self-reported fault (`Ton ausgefallen` …), or a same-origin 404/5xx | host, self-report, or this dashboard's own nginx |
| dark glass | no evidence (still checking, no or stale `status.json`, not listed in it), so no word either | — |

Status words stay fixed: `In Betrieb` / `Ausgefallen` / `Nicht erreichbar` (EN
`Running` / `Down` / `Unreachable`), plus the specific ones (`HTTP 503`,
`Keine Antwort`, `Letzter Lauf fehlgeschlagen`, `Absichtlich stumm`, health words).
A static `status`, `statusPolicy.staticState` or `probe: false` in a config only
turns the browser probe off for that URL (CORP, auth walls); it is never shown as a
state. Such a card lights only on the host's word.

The hero's lens and headline claim no more than the cards do. Only host-vouched
cards (lit green: host, self-report, or both) count as running, so `All N services
running` and a solid green lens need every card vouched. A green ring alone (this
browser reached it) never counts: a fresh artifact that lists none of the services
reads `No host report for any of the N services` under a ringed or dark lens; a
mix reads `K of N services running` under a dimmed lens. The split lens (green in
amber) is shown only when every unreachable card is host-confirmed; otherwise the
lens is an amber ring.

The board re-reads `status.json` and re-probes about every 60 s. A probe that is
still in flight is never replaced or discarded by the next sweep, so its result
always lands, and a re-check keeps the previous answer on screen (`aria-busy`)
instead of flickering. A single failed read of `status.json` keeps the last
artifact while it is younger than five minutes; after that it is ignored.

### Presentation fields

All optional, in `config.js` (or a manifest):

```js
presentation: { audience: "family", density: "tiles" }, // or "operator", "list"
contact: { name: "Markus" },                            // first name only, may be { en, de }
palette: { accent: "blue" },                            // "blue", "graphite" or "#RRGGBB"
```

- `audience: "family"` gives larger tiles, plain-language headlines and a
  "Was jetzt? / What now?" guide on failure, unreachable and stale states.
  `"operator"` (the default) gives an attention list with the evidence per failure.
- `density` is the start layout; family boards default to tiles, operator boards to
  the list. A choice made on the board is remembered per board.
- `contact.name` is named in the guidance ("Am besten Markus Bescheid geben").
  **This repository is public: a first name only, never a phone number, email or
  address.** Without a contact the guide says to tell whoever looks after the device.
- `palette.accent` colours buttons, focus rings and the host badge. Hex accents are
  darkened or lightened per appearance until they meet WCAG AA contrast. A manifest's
  `palette.accent` (or `gradient.primary`) is used the same way.

A nixcfg manifest carries services but no presentation; the board's own `config.js`
still supplies `presentation` and `contact` when its `slug` matches.

Remembered in `localStorage`: `hostdash.lang` and `hostdash.theme` (origin-wide),
and per board `hostdash.<board>.wing`, `.zoom`, `.zoomMode` and `.density`.

## Language

Use the header's DE / EN buttons to switch language without reloading. HostDash
uses the first supported language in the browser's language list, defaulting to
English, until a choice is saved in the origin-wide `localStorage` key
`hostdash.lang` (`de` or `en`). Same-origin apps such as `/fernsehen/` may share
this key; changes in another tab update the dashboard too. Switching keeps the
current search, category filter, and zoom.

User-visible config strings can remain plain strings or use translation objects,
for example `purpose: { en: "Home automation", de: "Hausautomation" }`. Host,
metadata, wing, and service text resolves to the selected language, then English,
then the first available string. Search uses the displayed language. Plain-string
manifests continue to work unchanged. One exception: a plain `heading` that is just
the stock word (`"Services"` or `"Dienste"`) is chrome, not a name, and follows the
language switch; any other plain string stays as configured. The family boards
(hsb8, hsb9) give their names and purposes in both languages.

## Build

```bash
nix build .#hsb1
nix build .#hsb0
nix build .#hsb8
nix build .#hsb9
nix build .#csb0
nix build .#csb1
```

Package outputs contain:

```text
share/hostdash-hsb1/index.html
share/hostdash-hsb0/index.html
share/hostdash-hsb8/index.html
share/hostdash-hsb9/index.html
share/hostdash-csb0/index.html
share/hostdash-csb1/index.html
```

If `manifest.json` is present beside `config.js`, the app loads the versioned
manifest first and falls back to `config.js` if the manifest is missing or
invalid.

The packaged `index.html` loads `config.js?v=<first 16 hex of its sha256>`, so a
browser that cached an old `config.js` fetches the new one on the next reload.
The stamp is applied in a phase of its own after every standard phase
(`postPhases`), so it hashes the `config.js` that is actually served, after any
consumer override in `postInstall`, `postFixup` or a replaced `installPhase`.
`scripts/check-package.sh` asserts the stamp, that the package is otherwise
byte-identical to `public/index.html`, that the two `hosts/hsb0/config.js`
strings nixcfg's hsb0 override replaces still exist, and, on an hsb0 package
overridden the way nixcfg does it, that the stamp follows the overridden file.

## UI Smoke Test

```bash
node scripts/smoke-ui.mjs
HOSTDASH_HOST=hsb0 node scripts/smoke-ui.mjs
HOSTDASH_HOST=hsb8 node scripts/smoke-ui.mjs
HOSTDASH_HOST=hsb9 node scripts/smoke-ui.mjs
HOSTDASH_HOST=csb0 node scripts/smoke-ui.mjs
HOSTDASH_HOST=csb1 node scripts/smoke-ui.mjs
HOSTDASH_HOST=hsb1 HOSTDASH_CONFIG_MODE=manifest node scripts/smoke-ui.mjs
HOSTDASH_HOST=hsb8 HOSTDASH_CONFIG_MODE=manifest node scripts/smoke-ui.mjs
```

The test launches a temporary headless Chromium-compatible browser profile,
assembles the same app/config shape as the package output, serves it over HTTP,
and verifies service counts, host bindings, same-host and path-only URLs,
cert-flagged services, the board's audience and start density, the evidence rule
(no lit LED or word without evidence, every failure visible and named), failure
guidance, search (`/`, Esc clears, a second Esc leaves), zoom (slider, steps, Fit,
100 %), Tiles/List, light/dark, the phone layout, both languages, and that the page
itself loads nothing from another origin. Set `BROWSER_PATH` to use a different
Chromium-compatible browser.

The `hsb1` manifest run adds test-local sentinels for all three host-truth
bindings and explicit `passive: false`. It also runs the same refresh assertions
as config mode against hsb1's real Mosquitto binding, so manifest sanitization
cannot silently fall back to browser-only truth.

For every host, the smoke test also serves a synthetic `status/status.json` and
rewrites it mid-session to check
that the board re-reads host truth on every sweep rather than once at load, that
an artifact older than `STATUS_MAX_AGE_MS` or a missing one leaves cards dark
instead of being trusted, and that host-side HTTP codes render as `HTTP 503`,
`No answer`, or (HTTP 200 on the host, no connection here) `Unreachable`. Path-only
services answer slower than a sweep on purpose, so a starved probe fails the run;
csb1's static `INSPR site` must stay dark until the host vouches for `inspr-www`.
The gate round-1 checks add: an artifact that lists no service never yields a green
or split lens or a "running" headline; `generated: "Infinity"` or a day ahead is not
evidence; a failed job record without a unit row is loud and a finished oneshot is
not `Down`; a running path-only service behind a same-origin 404 reads `HTTP 404`;
the babycam's empty or malformed telemetry claims nothing; focus survives a
recovery (attention chip, guide button, Failures group); the theme switch flips
with storage blocked; and the section heading follows the language on every board.
`SMOKE_SOFT=1` collects those round-1 failures instead of stopping at the first.

`scripts/test-evidence.mjs` runs the page's evidence core (the block between the
`// <evidence-core>` markers in `public/index.html`) in a bare Node VM: probes
cannot be starved by fast sweeps, a hung probe still settles, the probe queue
cannot starve its tail but drains in batches, static statuses go through the
evidence rules, timestamps, telemetry, jobs, same-origin HTTP codes, same-host URL
resolution and the hero verdict follow the evidence, and the rest of the truth
model holds. Every check runs; failures are listed together. No browser needed.

## Host Status Artifact

The board reads `./status/status.json` from the same origin, written on the host
by `services.hostdash.status` in nixcfg. Schema `inspr.hostdash.status.v1`:

```json
{
  "schema": "inspr.hostdash.status.v1",
  "generated": 1786208496,
  "containers": { "scrypted": { "running": true, "health": null } },
  "units":      { "adguardhome.service": { "running": true } },
  "extras":     { "babycam": { "health": "OK", "desired_volume": 0 } },
  "http":       { "scrypted": { "code": 200, "ms": 11 } }
}
```

`generated` must be epoch seconds (a number, or a plain decimal string). An
artifact without a valid one, or dated more than 120 s ahead of the browser's
clock, is not evidence (`Status file not usable`): a stamp that cannot age would
never expire. `extras` count only as an explicit health report: an object whose
`health` is a non-empty string (`"OK"`, or a fault code). `{}`, `null` or a
non-string `health` claim nothing, and the card falls back to its other evidence.

`http` is optional and keyed by container/unit name (or a service's `httpKey`).
So is `jobs`, keyed the same way: `{ "restic.timer": { "ok": false, "last": 1786200000 } }`
renders as `Letzter Lauf fehlgeschlagen` / `Last run failed`; `ok: true` as
`Letzter Lauf ok`. A job record counts on its own, with or without a `units`
row, and a oneshot unit that is `inactive` between runs with an ok last run is a
finished job, not a stopped daemon (`failed` stays red; a stopped container stays
`Down`). Today's generator does not write it.
It exists because a browser cannot read a status code — a `no-cors` fetch resolves
on a 500 exactly as on a 200 — so only the host can distinguish a broken service
from an unreachable one. `code >= 500` renders as `HTTP 503` (red), `code: 0`
(curl got no response at all) as `No answer` (red), and a good code paired with a
failing browser probe as `Unreachable` with a green core in an amber ring and
"HTTP 200 on the host" in its evidence: running and answering, just not reachable
from here. Omit the section entirely and every card falls back to probe-only behavior.

## JoeDesk

[JoeDesk](https://github.com/markus-barta/joedesk) is independently maintained
and released. [Open the board](https://cs0.barta.cm/joe/) at its existing protected
address. Host-specific dashboard navigation stays in `hosts/<host>/config.js`;
HostDash packages no `/joe/` page or application subtree. Application assets,
contracts, and tests live in JoeDesk. HostDash updates no longer release the board.

## QA Checklist

Before pushing or redeploying, run:

```bash
scripts/check-package.sh
node scripts/test-evidence.mjs
node --check scripts/smoke-ui.mjs
node scripts/smoke-ui.mjs
HOSTDASH_HOST=hsb0 node scripts/smoke-ui.mjs
HOSTDASH_HOST=hsb8 node scripts/smoke-ui.mjs
HOSTDASH_HOST=hsb9 node scripts/smoke-ui.mjs
HOSTDASH_HOST=csb0 node scripts/smoke-ui.mjs
HOSTDASH_HOST=csb1 node scripts/smoke-ui.mjs
HOSTDASH_HOST=hsb1 HOSTDASH_CONFIG_MODE=manifest node scripts/smoke-ui.mjs
HOSTDASH_HOST=hsb8 HOSTDASH_CONFIG_MODE=manifest node scripts/smoke-ui.mjs
nix build .#hsb1 --no-link
nix build .#hsb0 --no-link
nix build .#hsb8 --no-link
nix build .#hsb9 --no-link
nix build .#csb0 --no-link
nix build .#csb1 --no-link
```

Deployment is indirect: push this repository, update the `hostdash` flake input
in `nixcfg`, then deploy each host configuration so `/etc/hostdash/<host>` points
at the new package output and the host's nginx dashboard container is recreated.

## Deployment Pattern

For a host, nixcfg pins this repo as a flake input and exposes the package via:

```nix
environment.etc."hostdash/hsb1".source =
  inputs.hostdash.packages.${pkgs.system}.hsb1;
```

The Docker compose service then mounts:

```yaml
/etc/hostdash/hsb1/share/hostdash-hsb1:/usr/share/nginx/html:ro
```

Adding a host means adding `hosts/<host>/config.js`, exposing a flake package
output, and mounting that package into the host's nginx dashboard service.

## Design Reference

The shipped board (HOSTD-83) implements the approved HOSTD-82 direction
"Lichter": glass LEDs, Tiles/List, the group rail, the hero with a bezel lens and an
LED front panel, Apple system fonts only, continuous corners where the engine
supports `corner-shape`, and reduced motion respected. `docs/design/hsb1-dashboard-concept.png`
is the historical reference from the first redesign pass. The page remains static
HTML/CSS/JS with no external fonts, scripts or requests of its own.

## Safety Notes

- No secrets are stored here.
- The page is static HTML/CSS/JS.
- TLS services with self-signed host certificates are marked explicitly instead
  of being counted as down.
