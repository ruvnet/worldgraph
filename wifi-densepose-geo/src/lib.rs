//! wifi-densepose-geo — geospatial satellite integration for RuView.
//!
//! Provides: IP geolocation, satellite tile fetching (Sentinel-2),
//! SRTM elevation, OSM buildings/roads, coordinate transforms,
//! temporal change tracking, and brain memory integration.

#[cfg(feature = "network")]
pub mod brain;
#[cfg(feature = "network")]
pub mod cache;
pub mod coord;
#[cfg(feature = "network")]
pub mod fuse;
#[cfg(feature = "network")]
pub mod locate;
#[cfg(feature = "network")]
pub mod osm;
pub mod register;
#[cfg(feature = "network")]
pub mod temporal;
#[cfg(feature = "network")]
pub mod terrain;
#[cfg(feature = "network")]
pub mod tiles;
pub mod types;

pub use types::*;
