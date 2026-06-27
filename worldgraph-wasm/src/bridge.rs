//! ADR-200 §2 — the `#[wasm_bindgen]` surface compiled into the browser module.
//!
//! This module is `wasm32`-only: it is a thin serializer over [`crate::core`]
//! and [`crate::overlay`]. All geometry, filtering, and provenance logic lives in
//! those host-testable modules; here we only marshal Rust values across the
//! JS boundary via `serde-wasm-bindgen`.
#![cfg(target_arch = "wasm32")]

use serde::Serialize;
use wasm_bindgen::prelude::*;
use wifi_densepose_geo::GeoRegistration;
use wifi_densepose_worldgraph::{SensorModality, WorldGraph, WorldId, WorldNode, EnuPoint};

use crate::core;
use crate::overlay::{self, TrajectoryStep};

/// Serialize any `Serialize` value to a *JSON-compatible* JS value: ids become
/// plain `number`s (not `BigInt`) and structs become plain objects (not `Map`),
/// matching the wire types the TypeScript bridge declares.
fn to_js<T: Serialize>(value: &T) -> Result<JsValue, JsValue> {
    let ser = serde_wasm_bindgen::Serializer::json_compatible();
    value.serialize(&ser).map_err(|e| JsValue::from_str(&e.to_string()))
}

fn modality_from_str(s: &str) -> Result<SensorModality, JsValue> {
    match s {
        "wifi_csi" | "wifi" | "csi" => Ok(SensorModality::WifiCsi),
        "mmwave" | "mm_wave" => Ok(SensorModality::MmWave),
        "uwb" => Ok(SensorModality::Uwb),
        "presence" => Ok(SensorModality::Presence),
        other => Err(JsValue::from_str(&format!("unknown modality: {other}"))),
    }
}

/// Browser-side handle to a live [`WorldGraph`] digital twin.
///
/// Constructed from an RVF/JSON payload (or empty, for the visual configurator),
/// it answers render and audit queries each frame and accepts authored / live
/// updates that serialize straight back to a compliant RVF payload.
#[wasm_bindgen]
pub struct WorldgraphBridge {
    graph: WorldGraph,
}

#[wasm_bindgen]
impl WorldgraphBridge {
    /// Load a digital twin from an RVF/JSON payload (the WorldGraph snapshot).
    #[wasm_bindgen(constructor)]
    pub fn new(rvf_json: &str) -> Result<WorldgraphBridge, JsValue> {
        console_error_panic_hook::set_once();
        let graph = WorldGraph::from_json(rvf_json.as_bytes())
            .map_err(|e| JsValue::from_str(&format!("invalid RVF payload: {e}")))?;
        Ok(Self { graph })
    }

    /// Start an empty twin registered to the WGS84 origin — the blank canvas the
    /// visual configurator authors into (ADR-202 §2).
    #[wasm_bindgen(js_name = empty)]
    pub fn empty() -> WorldgraphBridge {
        console_error_panic_hook::set_once();
        Self { graph: WorldGraph::new(GeoRegistration::default()) }
    }

    /// Live node count.
    #[wasm_bindgen(js_name = nodeCount)]
    pub fn node_count(&self) -> usize {
        self.graph.node_count()
    }

    /// Physically renderable nodes (rooms, zones, sensors, anchors, people…).
    #[wasm_bindgen(js_name = getSemanticNodes)]
    pub fn get_semantic_nodes(&self) -> Result<JsValue, JsValue> {
        to_js(&core::physical_nodes(&self.graph).map_err(jserr)?)
    }

    /// Every live node, including abstract ones (events, beliefs, rf-links).
    #[wasm_bindgen(js_name = getAllNodes)]
    pub fn get_all_nodes(&self) -> Result<JsValue, JsValue> {
        to_js(&core::nodes(&self.graph).map_err(jserr)?)
    }

    /// Every live edge as `[fromId, toId, edge]` triples.
    #[wasm_bindgen(js_name = getEdges)]
    pub fn get_edges(&self) -> Result<JsValue, JsValue> {
        to_js(&core::edges(&self.graph).map_err(jserr)?)
    }

    /// Render-ready primitives (ENU-mapped, coloured) for the whole twin.
    #[wasm_bindgen(js_name = getRenderPrimitives)]
    pub fn get_render_primitives(&self) -> Result<JsValue, JsValue> {
        to_js(&core::render_primitives(&self.graph).map_err(jserr)?)
    }

    /// The click-to-audit provenance card for a node id, or `null`.
    #[wasm_bindgen(js_name = getProvenance)]
    pub fn get_provenance(&self, id: u64) -> Result<JsValue, JsValue> {
        match core::provenance_for(&self.graph, WorldId(id)) {
            Some(card) => to_js(&card),
            None => Ok(JsValue::NULL),
        }
    }

    /// Build an OccWorld predictive-trajectory overlay from a JS array of
    /// `{ point: {east_m,north_m,up_m}, probability }` steps.
    #[wasm_bindgen(js_name = trajectoryOverlay)]
    pub fn trajectory_overlay(
        &self,
        track_id: u64,
        from_e: f64,
        from_n: f64,
        from_u: f64,
        steps: JsValue,
    ) -> Result<JsValue, JsValue> {
        let steps: Vec<TrajectoryStep> =
            serde_wasm_bindgen::from_value(steps).map_err(|e| jserr(e.to_string()))?;
        let from = EnuPoint { east_m: from_e, north_m: from_n, up_m: from_u };
        to_js(&overlay::trajectory_overlay(track_id, &from, &steps))
    }

    /// Upsert a person track (live RF/ambient update). `id == 0` allocates a
    /// fresh node; pass the returned id back on the next frame to move it.
    #[wasm_bindgen(js_name = upsertPerson)]
    pub fn upsert_person(&mut self, id: u64, track_id: u64, e: f64, n: f64, u: f64) -> u64 {
        let world_id = if id == 0 { WorldId::UNASSIGNED } else { WorldId(id) };
        self.graph
            .upsert_node(WorldNode::PersonTrack {
                id: world_id,
                track_id,
                last_position: EnuPoint { east_m: e, north_m: n, up_m: u },
                reid_embedding_ref: None,
            })
            .0
    }

    /// Remove a node (e.g. a person who has left the building).
    #[wasm_bindgen(js_name = removeNode)]
    pub fn remove_node(&mut self, id: u64) -> bool {
        self.graph.remove_node(WorldId(id)).is_some()
    }

    /// Author a room from a dragged 3-D box gizmo (PlayCanvas centre + size).
    #[wasm_bindgen(js_name = addRoomFromBox)]
    pub fn add_room_from_box(
        &mut self,
        name: &str,
        area_id: Option<String>,
        cx: f64,
        cy: f64,
        cz: f64,
        sx: f64,
        sy: f64,
        sz: f64,
        floor: i16,
    ) -> u64 {
        let node = core::room_from_box(area_id, name, [cx, cy, cz], [sx, sy, sz], floor);
        self.graph.upsert_node(node).0
    }

    /// Author a sensor from a dropped marker at a PlayCanvas position.
    #[wasm_bindgen(js_name = addSensorFromMarker)]
    pub fn add_sensor_from_marker(
        &mut self,
        device_id: &str,
        x: f64,
        y: f64,
        z: f64,
        modality: &str,
    ) -> Result<u64, JsValue> {
        let node = core::sensor_from_marker(device_id, [x, y, z], modality_from_str(modality)?);
        Ok(self.graph.upsert_node(node).0)
    }

    /// Serialize the live twin back to an RVF/JSON payload (configurator export).
    #[wasm_bindgen(js_name = exportRvfJson)]
    pub fn export_rvf_json(&self) -> Result<String, JsValue> {
        let bytes = self.graph.to_json().map_err(|e| jserr(e.to_string()))?;
        String::from_utf8(bytes).map_err(|e| jserr(e.to_string()))
    }
}

fn jserr(msg: impl AsRef<str>) -> JsValue {
    JsValue::from_str(msg.as_ref())
}
