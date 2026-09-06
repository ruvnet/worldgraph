# worldgraph

**A privacy-aware environmental digital twin — and an AI agent that helps you build one.**

`worldgraph` is two things in one project:

1. **A Rust library** that models a physical space as a typed, provenance-tracked graph — rooms, zones, sensors, people, and *beliefs* about what's happening — geospatially grounded and able to **forecast occupancy**.
2. **An AI coding agent** (`npx worldgraphs`) — architect → implement → review → test — that helps you build digital twins and spatial/sensor applications on top of it.

<sub>**Keywords:** digital twin · world model · environmental digital twin · spatial computing · indoor positioning · sensor fusion · occupancy modeling · ambient intelligence · knowledge graph · scene graph · WiFi sensing · RF sensing · privacy-by-design · provenance · geospatial · occupancy forecasting · Rust · AI coding agent · agent harness</sub>

[![npm](https://img.shields.io/npm/v/worldgraphs.svg)](https://www.npmjs.com/package/worldgraphs)
[![License](https://img.shields.io/badge/license-MIT%2FApache--2.0-blue.svg)](#license)
[![Rust](https://img.shields.io/badge/rust-stable-orange.svg)](#-the-library--rust-crates)

---

## RuLab 4D world

**[Open RuLab](https://ruvnet.github.io/worldgraph/)** · [Implementation and controls](rulab/README.md) · [Architecture decision](docs/adr/205-rulab-temporal-gaussian-world.md) · [Review evidence](docs/mission/rulab-review.md)

Navigate an authored research facility through space and time. The browser combines Three.js materials with 42,442 actual anisotropic Gaussian primitives rendered by Spark. Pause a 120 second experiment, move the camera independently, inspect six persistent objects, operate the RF door, and rewind to reproduce the same state. Robotics, hospitality and healthcare configurations have separate event branches.

The **actual Rust WorldGraph core runs through WebAssembly**, maintaining 14 nodes and 14 relationships in an ENU coordinate frame. Timeline and graph exports stay on the device. Local Gaussian PLY, SPLAT and bounded SPZ imports support captured scenes; imported coordinates remain unverified until calibrated. RAD import is disabled pending bounded decompression support.

The supplied architectural images are concept references. This demo implements authored geometry and deterministic kinematics. It does not reconstruct the facility from those images, train a learned world model, or establish state of the art accuracy. The [research assessment](docs/adr/205-rulab-temporal-gaussian-world.md) explains how a measured capture and prediction pipeline can extend it.

```bash
npm ci
npm --prefix rulab ci
cargo install wasm-pack --version 0.14.0 --locked
npm --prefix rulab run build:wasm
npm --prefix rulab run dev
```

Open `http://localhost:4173/worldgraph/`. Run the complete source, Rust, WASM, unit, production build and browser gates from the repository root:

```bash
npx --prefix rulab playwright install --with-deps chromium
node bin/cli.js rulab verify
```

The harness writes gate logs, source identity and SHA256 evidence under `.artifacts/rulab/`. Every required gate must pass. `--without-browser` records a skipped browser gate and cannot produce an overall pass. CI uses Chromium with ANGLE/SwiftShader for actual WebGL2 execution; those measurements are **software rendering evidence**, not physical GPU performance claims. GitHub Pages publishes only after validation on `main`.

The new read only MCP tools are available from a source checkout with `node bin/cli.js mcp start`. They create mission and validation plans and check evidence structure; they do not run arbitrary shell commands or independently verify caller supplied claims. Published npm version 0.1.3 predates these additions.

The existing authenticated live stream remains available through [the Docker browser demo](demo/web/README.md) and [self hosting instructions](deploy/README.md).

---

## Two ways to use it

### 🤖 The AI agent — `npx worldgraphs`

A focused coding harness (architect / implementer / reviewer / test-writer) that drops into your AI host and helps you design, build, review, and test digital-twin code.

```bash
npx worldgraphs init       # wire the agents into your AI host (Claude Code, Codex, Copilot, …)
npx worldgraphs doctor     # health check

# or install globally:
npm i -g worldgraphs
worldgraphs init
```

> **Why `worldgraphs` (plural)?** npm reserves the bare name `worldgraph` (too similar to
> the existing `world-graph` package), so the npm package is published as `worldgraphs`.
> You can also run it straight from this repo: `npx ruvnet/worldgraph`.

Then ask your host to design or implement a change — the four agents run an opinionated pipeline so you get a plan, clean code, a bug-hunting review, and the missing tests. Ships adapters for **9 hosts**: Claude Code, Codex, Copilot, OpenCode, GitHub Actions, pi-dev, Hermes, OpenClaw, RVM.

| Agent | Role |
|-------|------|
| **architect** | Designs the change before any code is written |
| **implementer** | Writes code that matches the surrounding style |
| **reviewer** | Hunts correctness bugs in the diff |
| **test-writer** | Adds the missing tests for the change |

### 📦 The library — Rust crates

```bash
cargo add wifi-densepose-worldgraph   # the typed digital-twin graph
```

| crate | role |
|-------|------|
| [`wifi-densepose-geo`](./wifi-densepose-geo) | **Geospatial grounding** — IP geolocation, satellite tiles, SRTM elevation, OSM buildings/roads, ENU↔geo transforms |
| [`wifi-densepose-worldgraph`](./wifi-densepose-worldgraph) | **The digital twin** — a `petgraph` graph of typed nodes + relations; provenance-mandatory semantic beliefs; JSON persistence |
| [`wifi-densepose-worldmodel`](./wifi-densepose-worldmodel) | **Predictive layer** — bridges person-track history to an OccWorld occupancy model and returns trajectory priors |
| [`worldgraph-stream`](./worldgraph-stream) | **Live replication** — authorized snapshots/deltas, pseudonymous presence, and the self-hosted WebSocket server |

---

## What is an "environmental digital twin"?

A digital twin is a live, queryable model of a real space. `worldgraph` builds one as a **typed graph** — rooms, zones, walls, doorways, sensors, RF links, person tracks, object anchors, events, and semantic-state *beliefs* — connected by typed relations (`observes`, `located_in`, `adjacent_to`, `supports`, `contradicts`, `derived_from`, `privacy_limited_by`).

It stores **what is believed about the space**, not raw sensor frames — and **every belief is auditable** back to the evidence that produced it.

### What makes it trustworthy

- **Provenance is mandatory** — every semantic belief carries `SemanticProvenance` (signal evidence + model + calibration + privacy decision). You can't record a belief without recording *why*.
- **Privacy is first-class** — a `PrivacyRollup` and `privacy_limited_by` relations make the privacy posture of any belief queryable; downstream consumers respect it.
- **Deterministic & versioned** — a serde enum model → a deterministic, schema-versioned wire layout; `to_json` / `from_json` round-trips the whole graph.
- **Geospatially grounded** — ties the local scene to real coordinates, terrain, and map features.
- **Predictive** — forecasts occupancy and emits trajectory priors that improve downstream tracking.

### Where it sits

```
sensor fusion  →  worldgraph (digital twin)  →  semantic / agent layer
  fused beliefs     typed belief graph            queries, reasoning, eval
                          │
                          └─→ worldmodel → occupancy forecast / trajectory priors
```

Part of the [RuView / wifi-densepose](https://github.com/ruvnet/wifi-densepose) ecosystem (ADR-139).

## Build

```bash
cargo build && cargo test      # the Rust library
npm install && npm test        # the agent harness
cd supersplat-bridge && npm ci && npm test && npm run build
```

## Self-host the live stream

The stream server validates audience-bound, short-lived JWTs, applies the same
privacy policy to snapshots and deltas, and exposes authenticated producer
ingest. See [`deploy/README.md`](deploy/README.md) for token scopes, TLS proxy
requirements, and the hardened Docker Compose deployment.

```bash
export WORLDGRAPH_TOKEN_SECRET="$(openssl rand -base64 48)"
docker compose up --build --detach
```

For the complete local browser → WebSocket → Rust/WASM demonstration:

```bash
docker compose -f compose.yaml -f compose.demo.yaml up --build
```

Then open <http://127.0.0.1:4173>. This explicit demo overlay uses a
loopback-only development token issuer and moving synthetic track; it is not a
production authentication configuration. See [`demo/web/README.md`](demo/web/README.md)
for the browser test and [`deploy/README.md`](deploy/README.md) for deployment
boundaries.

## License

Dual-licensed **MIT OR Apache-2.0** — see [`LICENSE-MIT`](./LICENSE-MIT) and [`LICENSE-APACHE`](./LICENSE-APACHE).
