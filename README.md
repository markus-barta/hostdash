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
hardcoding one network.

A service served by the dashboard's own nginx declares `path` and no `port`
(hsb0's hausnetz at `/ops/`, In flight at `/inflight/`). It keeps the
dashboard's own origin, port included. Its probe is same-origin and so readable:
a `403` or `502` from that nginx counts as a failed probe, not as online.

## Language

Use the sidebar's DE / EN buttons to switch language without reloading. HostDash
uses the first supported language in the browser's language list, defaulting to
English, until a choice is saved in the origin-wide `localStorage` key
`hostdash.lang` (`de` or `en`). Same-origin apps such as `/fernsehen/` may share
this key; changes in another tab update the dashboard too. Switching keeps the
current search, category filter, and zoom.

User-visible config strings can remain plain strings or use translation objects,
for example `purpose: { en: "Home automation", de: "Hausautomation" }`. Host,
metadata, wing, and service text resolves to the selected language, then English,
then the first available string. Search uses the displayed language. Plain-string
manifests continue to work unchanged.

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
and verifies render counts, online counters, search hotkeys/filtering, Escape
reset, zoom behavior, cert-flagged services, and that search/zoom controls remain
in the responsive sidebar. Set `BROWSER_PATH` to use a different
Chromium-compatible browser.

The `hsb1` manifest run adds test-local sentinels for all three host-truth
bindings and explicit `passive: false`. It also runs the same refresh assertions
as config mode against hsb1's real Mosquitto binding, so manifest sanitization
cannot silently fall back to browser-only truth.

For every host, the smoke test also serves a synthetic `status/status.json` and
rewrites it mid-session to check
that the board re-reads host truth on every sweep rather than once at load, that
an artifact older than `STATUS_MAX_AGE_MS` degrades to `unknown` instead of being
trusted, and that host-side HTTP codes render as `Fault`/`OK on host`. It also
removes the artifact and checks the neutral-display rule in both languages: no
pill and no `Unknown`/`Unbekannt` on a card without evidence, a calm status-source
line with the operator detail kept in its tooltip, and every real failure
(`down`, `stopped`, `fault`) still rendered with a visible label.

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

`http` is optional and keyed by container/unit name (or a service's `httpKey`).
It exists because a browser cannot read a status code — a `no-cors` fetch resolves
on a 500 exactly as on a 200 — so only the host can distinguish a broken service
from an unreachable one. `code >= 500` renders as `Fault`, `code: 0` (curl got no
response at all) as `Fault · no answer`, and a good code paired with a failing
browser probe as `OK on host`: running and answering, just not reachable from
here. Omit the section entirely and every card falls back to probe-only behavior.

## Status Display

A card shows a state pill only on evidence: a fresh artifact entry for its
container or unit, a host-side HTTP result, the service's own telemetry, or a
settled browser probe. Without evidence (still checking, no artifact, a stale
artifact, a passive card the artifact does not list) the card shows no pill at
all. Its tooltip names the reason, and it stays out of the online count. A missing
or stale artifact turns the sidebar's source line neutral ("Checked in this
browser" / "Im Browser geprüft"), and its tooltip keeps the precise reason. Down,
stopped and fault are always shown, mark the card with a red edge, and drive the
hero summary ("1 service needs attention" / "1 Dienst gestört") and a red dot on the
tab icon.

Boards with eight services or fewer (hsb8, hsb9) render in a comfortable density
with larger tiles and an always-visible "Open" cue; larger boards stay compact.

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

`docs/design/hsb1-dashboard-concept.png` is the generated visual reference used
for the first redesign pass. The shipped page remains static HTML/CSS/JS.

## Safety Notes

- No secrets are stored here.
- The page is static HTML/CSS/JS.
- TLS services with self-signed host certificates are marked explicitly instead
  of being counted as down.
