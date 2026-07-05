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
HOSTDASH_HOST=hsb8 HOSTDASH_CONFIG_MODE=manifest node scripts/smoke-ui.mjs
```

The test launches a temporary headless Chromium-compatible browser profile,
assembles the same app/config shape as the package output, and verifies render
counts, online counters, search hotkeys/filtering, Escape reset, zoom behavior,
TLS-cert badges, and that search/zoom controls remain in the responsive sidebar.
Set `BROWSER_PATH` to use a different Chromium-compatible browser.

## QA Checklist

Before pushing or redeploying, run:

```bash
node --check scripts/smoke-ui.mjs
node scripts/smoke-ui.mjs
HOSTDASH_HOST=hsb0 node scripts/smoke-ui.mjs
HOSTDASH_HOST=hsb8 node scripts/smoke-ui.mjs
HOSTDASH_HOST=hsb9 node scripts/smoke-ui.mjs
HOSTDASH_HOST=csb0 node scripts/smoke-ui.mjs
HOSTDASH_HOST=csb1 node scripts/smoke-ui.mjs
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
