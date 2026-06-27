# @worldgraph/supersplat-bridge

TypeScript / PlayCanvas integration that renders the
[WorldGraph](https://github.com/ruvnet/worldgraph) privacy-aware digital twin
over a [SuperSplat](https://github.com/playcanvas/supersplat) Gaussian splat —
in the browser, via WebAssembly, with no backend.

See the repo's [`INTEGRATION.md`](../INTEGRATION.md) for the end-to-end build and
[`docs/adr/ADR-200..203`](../docs/adr/) for the design.

## Install & build

```bash
npm install
npm run build         # tsc → dist/
npm test              # vitest (headless; injects a fake WASM module)
npm run typecheck     # tsc --noEmit, strict
```

The Rust→WASM module (`src/worldgraph-wasm/`) is produced separately by
`../worldgraph-wasm/build-wasm.sh` and is git-ignored.

## Surface

- `SemanticVisualizer` — typed wrapper over the WASM `WorldgraphBridge`; the
  module is injected so it unit-tests without a browser.
- `WorldgraphScene` + `PlayCanvasBackend` — a frame-by-frame reconciler that
  creates / moves / destroys scene entities from `RenderPrimitive`s.
- `types.ts` — the WorldGraph serde wire format, exactly (`kind`-tagged nodes,
  `EnuPoint{east_m,…}`, `bounds_enu` shape-union).
- Four use-case modules: `avatars`, `configurator`, `occworld`, `audit`.

## Wire-format note

This package targets the **actual** serde representation of
`wifi-densepose-worldgraph`. If you saw an example using `node.type`,
`ZoneBoundsEnu`, or `{east,north,up}` — those shapes do not exist here. Use
`node.kind`, `node.bounds_enu`, `{east_m,north_m,up_m}`.

## License

MIT OR Apache-2.0
