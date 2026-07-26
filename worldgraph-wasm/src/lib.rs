//! # worldgraph-wasm (ADR-200)
//!
//! The WebAssembly bridge that exposes the [`wifi_densepose_worldgraph`]
//! environmental digital twin to the **SuperSplat** (PlayCanvas / WebGPU) browser
//! visualizer — turning a static Gaussian splat and a blind semantic graph into a
//! live, photorealistic, privacy-first overlay.
//!
//! ## Layering
//!
//! - [`enu`] — the ENU ⇄ PlayCanvas coordinate contract (ADR-201).
//! - [`core`] — pure, host-testable derivation: physical-node filtering,
//!   render-primitive geometry, click-to-audit provenance cards, and the visual
//!   configurator's PlayCanvas→ENU projection (ADR-202 §2/§4).
//! - [`overlay`] — OccWorld predictive-trajectory primitives (ADR-202 §3).
//! - [`bridge`] — the `wasm32`-only `#[wasm_bindgen]` surface; a thin serializer
//!   over the modules above (ADR-200 §2).
//!
//! The split is deliberate: the `wasm32` target needs `wasm-bindgen` and a
//! browser to run, so all *logic* lives outside `bridge` where `cargo test`
//! exercises it on the host. The wire format the browser consumes is therefore
//! pinned by native unit tests, not by manual inspection in three-space.

#![forbid(unsafe_code)]

pub mod core;
pub mod enu;
pub mod overlay;

#[cfg(target_arch = "wasm32")]
pub mod bridge;

pub use core::{ProvenanceCard, RenderPrimitive, PrimitiveShape, KeyVal};
pub use overlay::TrajectoryStep;
