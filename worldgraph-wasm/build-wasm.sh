#!/usr/bin/env bash
# ADR-200 — compile the WorldGraph bridge to a browser-ready WASM module and
# drop it where the SuperSplat frontend imports it.
#
# Prereqs (install once on the build host):
#   rustup target add wasm32-unknown-unknown
#   cargo install wasm-pack
#
# Output: ../supersplat-bridge/src/worldgraph-wasm/{worldgraph_wasm.js,_bg.wasm,.d.ts}
set -euo pipefail

OUT_DIR="${1:-../supersplat-bridge/src/worldgraph-wasm}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v wasm-pack >/dev/null 2>&1; then
  echo "error: wasm-pack not found. Install with: cargo install wasm-pack" >&2
  exit 1
fi

echo "→ building worldgraph-wasm (target=web) into ${OUT_DIR}"
cd "${HERE}"
# Rust's release optimizer is always enabled. Binaryen is optional so a clean
# build never depends on an unpinned binary download from a release CDN.
OPT_ARGS=(--no-opt)
if [[ "${WORLDGRAPH_WASM_OPT:-0}" == "1" ]]; then OPT_ARGS=(); fi
wasm-pack build --release --locked --target web --out-name worldgraph_wasm --out-dir "${OUT_DIR}" "${OPT_ARGS[@]}"
echo "✓ done. Import in TS:  import init, { WorldgraphBridge } from './worldgraph-wasm/worldgraph_wasm.js'"
