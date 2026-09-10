#!/usr/bin/env bash
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
hosts=(csb0 csb1 hsb0 hsb1 hsb8 hsb9)

fail() {
  echo "check-package: $*" >&2
  exit 1
}

[[ ! -e "${repo}/public/joe" ]] || fail "retired public/joe subtree still exists"
[[ -s "${repo}/public/index.html" ]] || fail "shared dashboard index is missing"

for host in "${hosts[@]}"; do
  source_config="${repo}/hosts/${host}/config.js"
  [[ -s "${source_config}" ]] || fail "${host}: source config is missing"
  grep -Eq 'url:[[:space:]]*"https?://' "${source_config}" ||
    fail "${host}: source config has no dashboard navigation URL"

  output="$(nix build --no-link --print-out-paths "${repo}#${host}")"
  package="${output}/share/hostdash-${host}"
  [[ -s "${package}/index.html" ]] || fail "${host}: packaged dashboard is missing"
  [[ -s "${package}/config.js" ]] || fail "${host}: packaged navigation is missing"
  [[ ! -e "${package}/joe" ]] || fail "${host}: package contains retired joe subtree"
  cmp -s "${repo}/public/index.html" "${package}/index.html" ||
    fail "${host}: packaged dashboard differs from source"
  cmp -s "${source_config}" "${package}/config.js" ||
    fail "${host}: packaged navigation differs from source"
done

echo "check-package: ok (${#hosts[@]} host packages, no retired joe subtree)"
