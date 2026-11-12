//! `worldgraph-pan2` — PAN 2 as a simulated-frame provider for worldgraph (ADR-208).
//!
//! [PAN 2](https://github.com/ifm-ai/PAN2) is an Apache-2.0 video world model
//! from MBZUAI's Institute of Foundation Models. Given a description of the
//! current scene and timed actions, it renders a clip of what might happen
//! next. This crate connects it to worldgraph without weakening the rule in
//! ADR-204: the sensed graph is authoritative and generated pixels are
//! explicitly simulated output.
//!
//! ```text
//!  RolloutPlan ──► SceneSeed + ActionChunk ──► ExternalSidecarProvider   (your machine)
//!                                                   │ Unix socket, JSON control only
//!                                                   ▼
//!                                  pan2-worker ──► upstream generate.py   (GPU host)
//!                                                   │ clip.mp4 + caption.json on disk
//!                 verified copy ◄── media channel ◄─┘
//!       │
//!       ├─► rollout bundle for RuLab        (`bundle`)
//!       ├─► zero-confidence SemanticState   (`projection`)
//!       └─► Cognitum Spaces event           (`spaces`)
//! ```
//!
//! * [`plan`] — typed request for one clip.
//! * [`compile`] and [`caption`] — deterministic scene-to-caption compiler.
//! * [`worker`] and [`renderer`] — GPU-side sidecar that runs the unmodified
//!   upstream generator. No model code is vendored or reimplemented here.
//! * [`media`] — hashing and descriptor verification for the media channel.
//! * [`bundle`], [`projection`], [`spaces`] — the three places a verified
//!   rollout can go.
//! * [`pipeline`] — the end-to-end client flow used by the `pan2-rollout` tool.
//!
//! A rollout is a prediction. Nothing in this crate labels it as a capture,
//! an observation, or evidence, and the confidence it records is always zero.

pub mod bundle;
pub mod canonical;
pub mod caption;
pub mod compile;
pub mod error;
pub mod layout;
pub mod media;
pub mod physical_spaces;
pub mod pipeline;
pub mod plan;
pub mod projection;
pub mod renderer;
pub mod spaces;
pub mod spaces_scene;
pub mod worker;

pub use error::Pan2Error;

/// Hugging Face repository of the released weights.
pub const PAN2_MODEL: &str = "IFM/PAN2";
