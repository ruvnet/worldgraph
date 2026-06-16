# worldgraph

**A privacy-aware environmental digital twin — and an AI agent that helps you build one.**

`worldgraph` is two things in one project:

1. **A Rust library** that models a physical space as a typed, provenance-tracked graph — rooms, zones, sensors, people, and *beliefs* about what's happening — geospatially grounded and able to **forecast occupancy**.
2. **An AI coding agent** (`npx ruvnet/worldgraph`) — architect → implement → review → test — that helps you build digital twins and spatial/sensor applications on top of it.

<sub>**Keywords:** digital twin · world model · environmental digital twin · spatial computing · indoor positioning · sensor fusion · occupancy modeling · ambient intelligence · knowledge graph · scene graph · WiFi sensing · RF sensing · privacy-by-design · provenance · geospatial · occupancy forecasting · Rust · AI coding agent · agent harness</sub>

[![run with npx](https://img.shields.io/badge/run-npx%20ruvnet%2Fworldgraph-black.svg)](#-the-ai-agent--npx-ruvnetworldgraph)
[![License](https://img.shields.io/badge/license-MIT%2FApache--2.0-blue.svg)](#license)
[![Rust](https://img.shields.io/badge/rust-stable-orange.svg)](#-the-library--rust-crates)

---

## Two ways to use it

### 🤖 The AI agent — `npx ruvnet/worldgraph`

A focused coding harness (architect / implementer / reviewer / test-writer) that drops into your AI host and helps you design, build, review, and test digital-twin code.

```bash
# run straight from this repo — no npm install needed:
npx ruvnet/worldgraph init      # wire the agents into your AI host (Claude Code, Codex, Copilot, …)
npx ruvnet/worldgraph doctor    # health check

# or install the `worldgraph` command globally:
npm i -g ruvnet/worldgraph
worldgraph init
```

> **Why `npx ruvnet/worldgraph` and not `npx worldgraph`?** npm reserves the bare name
> `worldgraph` (it's too similar to the existing `world-graph` package), so the agent
> runs from this GitHub repo instead — same name, no npm-registry collision.

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
```

## License

Dual-licensed **MIT OR Apache-2.0** — see [`LICENSE-MIT`](./LICENSE-MIT) and [`LICENSE-APACHE`](./LICENSE-APACHE).
