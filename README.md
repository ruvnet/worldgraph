# worldgraph

Environmental digital-twin + world-model crates for the RuView / wifi-densepose
ecosystem (ADR-139). Extracted as a standalone cargo workspace; consumed by the
parent repo as a git submodule.

| crate | role |
|-------|------|
| `wifi-densepose-geo` | geospatial primitives (leaf) |
| `wifi-densepose-worldgraph` | WorldGraph environmental digital twin (petgraph-backed) — depends on `geo` |
| `wifi-densepose-worldmodel` | world-model layer over the graph — depends on `worldgraph` |

## Build
```bash
cargo build
cargo test
```
