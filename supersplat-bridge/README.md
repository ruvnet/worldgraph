# @worldgraph/supersplat-bridge

TypeScript / PlayCanvas integration that renders the
[WorldGraph](https://github.com/ruvnet/worldgraph) privacy-aware digital twin
over a [SuperSplat](https://github.com/playcanvas/supersplat) Gaussian splat.
It supports local WebAssembly twins and authenticated live snapshot/delta streams.

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
  creates / moves / destroys scene entities from `RenderPrimitive`s, including
  cancel-safe asynchronous glTF/GLB assets.
- `TwinStreamClient` — protocol negotiation, epoch/sequence validation,
  WebTransport preference and WebSocket fallback. Transports are injectable for
  alternative framing and headless tests.
- `PresenceLayer` — ephemeral, pseudonymous `viewer_presence` spheres kept
  separate from sensed `person_track` nodes.
- `types.ts` — the WorldGraph serde wire format, exactly (`kind`-tagged nodes,
  `EnuPoint{east_m,…}`, `bounds_enu` shape-union).
- Use-case modules: `avatars`, `presence`, `configurator`, `occworld`, `audit`.

## Live stream

`TwinStreamClient` sends the short-lived token in `ClientHello` after the
encrypted connection opens; it never appends credentials to an endpoint URL.
The built-in WebTransport adapter uses newline-delimited JSON on one reliable
bidirectional stream. Servers using a different framing scheme should inject a
`StreamTransport`. Call `onDelta` to reconcile the scene only after a message
has been accepted and applied by WASM.

## Runtime asset and renderer integration

Construct `PlayCanvasBackend` with the live PlayCanvas namespace/application and
an `instantiateAsset(bytes, format, sourceUrl, signal)` hook. The hook must turn
validated glTF/GLB bytes into a `pc.Entity`; the adapter attaches it to the app.
Configure an explicit HTTPS origin allow-list, byte/time limits, and optionally
require SHA-256 SRI. Asset origins must serve CORS headers, and the host CSP must
permit them in `connect-src` (and any PlayCanvas texture directives in use).

Pass `preferredDeviceOptions` to PlayCanvas device creation to try WebGPU then
WebGL2. The backend exposes `capabilities` and delegates `startXr()` to the
injected XR starter. Applications must call `startXr()` directly from a browser
user gesture; browser/device loss and XR session lifecycle remain owned by the
host PlayCanvas application.

## Wire-format note

This package targets the **actual** serde representation of
`wifi-densepose-worldgraph`. If you saw an example using `node.type`,
`ZoneBoundsEnu`, or `{east,north,up}` — those shapes do not exist here. Use
`node.kind`, `node.bounds_enu`, `{east_m,north_m,up_m}`.

## License

MIT OR Apache-2.0
