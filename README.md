# hsb1-home-dashboard

Static service dashboard currently served at `http://hsb1/`.

The first version is an extraction of the live `hsb1-home` page that was
previously served from:

```text
/home/mba/docker/mounts/hsb1-home/index.html
```

The dashboard is packaged as a Nix flake output so host configs can mount the
resulting immutable directory into an nginx container.

## Build

```bash
nix build .#hsb1
```

The package output contains:

```text
share/hsb1-home-dashboard/index.html
```

## UI Smoke Test

```bash
node scripts/smoke-ui.mjs
```

The test launches a temporary headless Chromium-compatible browser profile and
checks that the dashboard renders, the online counter initializes, `/` focuses
search, search filters cards, and Escape clears the filter. Set `BROWSER_PATH`
to use a different Chromium-compatible browser.

## Design Reference

`docs/design/hsb1-dashboard-concept.png` is the generated visual reference used
for the first redesign pass. The shipped page remains static HTML/CSS/JS in
`public/index.html`.

## Deployment Pattern

For hsb1, nixcfg pins this repo as a flake input and exposes the package via:

```nix
environment.etc."hsb1-home-dashboard".source =
  inputs.hsb1-home-dashboard.packages.${pkgs.system}.hsb1;
```

The Docker compose service then mounts:

```yaml
/etc/hsb1-home-dashboard/share/hsb1-home-dashboard:/usr/share/nginx/html:ro
```

The pattern is reusable for other hosts by adding another package output with
that host's static dashboard assets and mounting the package directory into the
same nginx image.

## Safety Notes

- No secrets are stored here.
- The page is static HTML/CSS/JS.
- The live hsb1 file was backed up before redeploying declaratively.
