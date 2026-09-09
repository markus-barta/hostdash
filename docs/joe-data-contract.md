# Joe household data contract

`/joe/` is a read-only projection of the paper-trading book. The browser reads
`/joe/data.json` every 15 seconds. The dashboard itself never reads the raw
`book.json`, contacts a broker, or places an order.

The canonical JSON Schema is served as `/joe/data.schema.json`. A synthetic,
non-secret example lives at `docs/examples/joe-data.sample.json`. The example is
not copied into the public package as `data.json`; a missing live projection must
produce an obvious `NO DATA` state rather than plausible-looking money.

## Projection rules

The producer that can read `~/trading-team/shared/book.json` must emit exactly:

- one snapshot with schema `inspr.joe.household.v1`, `mode: PAPER`, and EUR values;
- exactly three unique desks: `j`, `joe`, and `joel`;
- a plain-language desk state: `working`, `sit-out`, or `stuck`;
- one current-action sentence and one learning/iteration summary per desk;
- paper equity, today's PnL, and since-start PnL per desk and in `totals`;
- the real HALT state, gateway health, and a short staleness threshold.

Use `null`, not zero, when a money value is unknown. Set `stuck` and add a short
entry to `issues` when a desk cannot continue. A down gateway, HALT, stale file,
or stuck desk becomes the prominent broken-state banner.

Do not copy raw account identifiers, order payloads, credentials, or the whole
book into this file. `data.json` is a small projection, not an archive.

## Atomic host sync

After the Mac-side `book.json` mapper produces a contract-valid snapshot, stage
and replace it atomically. Adapt only `JOE_WEBROOT` to the hsb1 nginx bind mount:

```bash
JOE_WEBROOT=/var/lib/joe-dashboard
install -d -m 0755 "$JOE_WEBROOT"
jq -e '.schema == "inspr.joe.household.v1" and .mode == "PAPER" and (.desks | length == 3)' joe-data.next.json >/dev/null
install -m 0644 joe-data.next.json "$JOE_WEBROOT/data.json.next"
mv "$JOE_WEBROOT/data.json.next" "$JOE_WEBROOT/data.json"
```

Bind-mount that single file at
`/usr/share/nginx/html/joe/data.json:ro` for hsb1. Do not mount it into cs0. The
shared static package shows the board on LAN/local hosts, Tailscale CGNAT IPv4
(`100.64.0.0/10`), and hsb1 `*.ts.net` names. Unknown public hostnames stay on a
private stub before any request for `data.json`, so `https://cs0.barta.cm/joe/`
contains no household PnL.

## Release/deploy hand-off

After this repository PR lands:

1. bump the `hostdash` flake input in `nixcfg`;
2. add the hsb1-only `data.json` bind mount/producer wiring;
3. build the hsb1 configuration;
4. deploy hsb1 through the normal HIL-gated host path if the change requires it;
5. verify `http://hsb1.lan/joe/` and this host's Tailscale IP render three desks and current paper data;
6. verify `https://cs0.barta.cm/joe/` renders only the private canonical stub and
   makes no `/joe/data.json` request.

This repository change does not perform the nixcfg bump or live deployment.
