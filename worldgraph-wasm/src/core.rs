//! ADR-200 §3 — the pure-Rust core of the bridge.
//!
//! Everything the browser can see is derived here, off the `wasm32` target, so
//! `cargo test` proves the wire contract (node filtering, render-primitive
//! geometry, ENU mapping, provenance cards, configurator round-trips) without a
//! headless browser. The `#[wasm_bindgen]` layer in [`crate::bridge`] is a thin
//! serializer over these functions.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use wifi_densepose_worldgraph::{
    AnchorKind, EnuPoint, SensorModality, WorldEdge, WorldGraph, WorldId, WorldNode, ZoneBoundsEnu,
};

use crate::enu::{enu_to_pc, enu_xyz_to_pc, pc_to_enu};

/// Default rendered room/zone height (m). WorldGraph footprints are 2-D (ENU
/// rectangles); SuperSplat needs a volume to draw, so we extrude to a sensible
/// ceiling height. Overridable per-call by the configurator.
pub const DEFAULT_ROOM_HEIGHT_M: f64 = 2.5;

/// Marker radius for point devices (sensors / anchors), in metres.
pub const MARKER_SIZE_M: f64 = 0.2;

/// Anonymous person avatar radius (m): roughly a standing adult capsule.
pub const AVATAR_RADIUS_M: f64 = 0.3;
/// Anonymous person avatar height (m).
pub const AVATAR_HEIGHT_M: f64 = 1.7;

/// Errors surfaced across the bridge boundary as strings (→ JS exceptions).
pub type CoreResult<T> = Result<T, String>;

/// The drawable shape for a [`RenderPrimitive`]. Maps 1:1 onto a PlayCanvas
/// `render` component `type` (except `Line`, drawn via `app.drawLine`).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PrimitiveShape {
    /// `pc` box — rooms, zones, doorways, anchors.
    Box,
    /// `pc` sphere — sensors.
    Sphere,
    /// `pc` cylinder — circular zones.
    Cylinder,
    /// `pc` capsule — anonymous person avatars.
    Capsule,
    /// `app.drawLine(position, to, color)` — walls, trajectory segments.
    Line,
}

/// A fully ENU-mapped, render-ready primitive. The TypeScript side instantiates
/// these verbatim — it never re-derives coordinates or colours.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RenderPrimitive {
    /// Source [`WorldId`].
    pub id: u64,
    /// WorldNode kind tag (`room`, `sensor`, `person_track`, …).
    pub kind: String,
    /// Drawable shape.
    pub shape: PrimitiveShape,
    /// Display label (name / device id / track tag).
    pub label: String,
    /// PlayCanvas position `[x, y, z]` (m), already ENU-mapped.
    pub position: [f64; 3],
    /// PlayCanvas local scale `[x, y, z]` (m).
    pub scale: [f64; 3],
    /// RGBA, each component in `0.0..=1.0`.
    pub color: [f32; 4],
    /// Endpoint in PlayCanvas space for `Line` primitives.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<[f64; 3]>,
    /// Translucent volume → TS sets `blendType = pc.BLEND_NORMAL`.
    pub transparent: bool,
}

/// One row of a provenance / audit card.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct KeyVal {
    /// Field label.
    pub key: String,
    /// Field value.
    pub value: String,
}

/// The "click-to-audit" payload (ADR-202 §4): why the system believes a node
/// exists, assembled from the node's own fields plus its provenance edges.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProvenanceCard {
    /// Source [`WorldId`].
    pub id: u64,
    /// WorldNode kind tag.
    pub kind: String,
    /// Card heading.
    pub title: String,
    /// One-line human-readable audit summary.
    pub summary: String,
    /// Structured detail rows.
    pub fields: Vec<KeyVal>,
    /// Evidence / `derived_from` content-address handles.
    pub evidence: Vec<String>,
}

/// Node kinds the bridge treats as physically renderable over the splat.
#[must_use]
pub fn is_physical(node: &WorldNode) -> bool {
    matches!(
        node,
        WorldNode::Room { .. }
            | WorldNode::Zone { .. }
            | WorldNode::Wall { .. }
            | WorldNode::Doorway { .. }
            | WorldNode::Sensor { .. }
            | WorldNode::PersonTrack { .. }
            | WorldNode::ObjectAnchor { .. }
    )
}

/// All live nodes, typed, via a deterministic `to_json` round-trip.
///
/// The WorldGraph deliberately exposes no public node iterator (its internal
/// petgraph handles are not part of the API); the snapshot JSON is the supported
/// read path, so the bridge consumes it rather than reaching into internals.
pub fn nodes(g: &WorldGraph) -> CoreResult<Vec<WorldNode>> {
    let snap = snapshot_value(g)?;
    serde_json::from_value(snap.get("nodes").cloned().unwrap_or(Value::Null))
        .map_err(|e| format!("decode nodes: {e}"))
}

/// All live edges as `(from, to, edge)` triples.
pub fn edges(g: &WorldGraph) -> CoreResult<Vec<(WorldId, WorldId, WorldEdge)>> {
    let snap = snapshot_value(g)?;
    serde_json::from_value(snap.get("edges").cloned().unwrap_or(Value::Null))
        .map_err(|e| format!("decode edges: {e}"))
}

/// Physically renderable nodes only (rooms, zones, sensors, anchors, people…).
pub fn physical_nodes(g: &WorldGraph) -> CoreResult<Vec<WorldNode>> {
    Ok(nodes(g)?.into_iter().filter(is_physical).collect())
}

fn snapshot_value(g: &WorldGraph) -> CoreResult<Value> {
    let bytes = g.to_json().map_err(|e| format!("snapshot: {e}"))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("parse snapshot: {e}"))
}

/// Build the render primitives for every physical node in the graph.
pub fn render_primitives(g: &WorldGraph) -> CoreResult<Vec<RenderPrimitive>> {
    Ok(nodes(g)?.iter().filter_map(primitive_for).collect())
}

/// Map a single node to its render primitive, or `None` if it is abstract
/// (events, rf-links, semantic beliefs have no fixed extent on the splat).
#[must_use]
pub fn primitive_for(node: &WorldNode) -> Option<RenderPrimitive> {
    match node {
        WorldNode::Room { id, name, bounds_enu, .. } => {
            Some(volume_primitive(id.0, "room", name, bounds_enu, [0.0, 1.0, 0.0, 0.25]))
        }
        WorldNode::Zone { id, name, bounds_enu, .. } => {
            Some(volume_primitive(id.0, "zone", name, bounds_enu, [0.0, 0.9, 1.0, 0.18]))
        }
        WorldNode::Sensor { id, device_id, position, modality } => Some(RenderPrimitive {
            id: id.0,
            kind: "sensor".into(),
            shape: PrimitiveShape::Sphere,
            label: device_id.clone(),
            position: enu_to_pc(position),
            scale: [MARKER_SIZE_M; 3],
            color: modality_color(*modality),
            to: None,
            transparent: false,
        }),
        WorldNode::ObjectAnchor { id, position, anchor_kind, confidence } => Some(RenderPrimitive {
            id: id.0,
            kind: "object_anchor".into(),
            shape: PrimitiveShape::Box,
            label: anchor_label(*anchor_kind),
            position: enu_to_pc(position),
            scale: [MARKER_SIZE_M * 1.5; 3],
            color: confidence_color(*confidence),
            to: None,
            transparent: false,
        }),
        WorldNode::PersonTrack { id, track_id, last_position, .. } => {
            let mut pos = enu_to_pc(last_position);
            pos[1] += AVATAR_HEIGHT_M / 2.0; // stand the capsule on the floor
            Some(RenderPrimitive {
                id: id.0,
                kind: "person_track".into(),
                // Anonymous by construction — no identity, just a track tag.
                label: format!("person #{track_id}"),
                shape: PrimitiveShape::Capsule,
                position: pos,
                scale: [AVATAR_RADIUS_M * 2.0, AVATAR_HEIGHT_M, AVATAR_RADIUS_M * 2.0],
                color: [0.0, 0.85, 1.0, 0.85],
                to: None,
                transparent: true,
            })
        }
        WorldNode::Doorway { id, center, width_m } => Some(RenderPrimitive {
            id: id.0,
            kind: "doorway".into(),
            shape: PrimitiveShape::Box,
            label: "doorway".into(),
            position: enu_to_pc(center),
            scale: [f64::from(*width_m), DEFAULT_ROOM_HEIGHT_M, 0.15],
            color: [1.0, 0.85, 0.1, 0.5],
            to: None,
            transparent: true,
        }),
        WorldNode::Wall { id, a, b, .. } => Some(RenderPrimitive {
            id: id.0,
            kind: "wall".into(),
            shape: PrimitiveShape::Line,
            label: "wall".into(),
            position: enu_to_pc(a),
            scale: [1.0; 3],
            color: [0.6, 0.6, 0.65, 1.0],
            to: Some(enu_to_pc(b)),
            transparent: false,
        }),
        // Abstract nodes are not drawn as fixed geometry.
        WorldNode::RfLink { .. } | WorldNode::Event { .. } | WorldNode::SemanticState { .. } => None,
    }
}

fn volume_primitive(
    id: u64,
    kind: &str,
    label: &str,
    bounds: &ZoneBoundsEnu,
    color: [f32; 4],
) -> RenderPrimitive {
    let h = DEFAULT_ROOM_HEIGHT_M;
    match bounds {
        ZoneBoundsEnu::Circle { center_e, center_n, radius_m } => RenderPrimitive {
            id,
            kind: kind.into(),
            shape: PrimitiveShape::Cylinder,
            label: label.into(),
            position: enu_xyz_to_pc(*center_e, *center_n, h / 2.0),
            scale: [radius_m * 2.0, h, radius_m * 2.0],
            color,
            to: None,
            transparent: true,
        },
        other => {
            let (min_e, min_n, max_e, max_n) = bbox_2d(other);
            RenderPrimitive {
                id,
                kind: kind.into(),
                shape: PrimitiveShape::Box,
                label: label.into(),
                position: enu_xyz_to_pc((min_e + max_e) / 2.0, (min_n + max_n) / 2.0, h / 2.0),
                scale: [(max_e - min_e).abs(), h, (max_n - min_n).abs()],
                color,
                to: None,
                transparent: true,
            }
        }
    }
}

/// Axis-aligned ENU bounding box `(min_e, min_n, max_e, max_n)` of any footprint.
#[must_use]
pub fn bbox_2d(bounds: &ZoneBoundsEnu) -> (f64, f64, f64, f64) {
    match bounds {
        ZoneBoundsEnu::Rectangle { min_e, min_n, max_e, max_n } => (*min_e, *min_n, *max_e, *max_n),
        ZoneBoundsEnu::Circle { center_e, center_n, radius_m } => (
            center_e - radius_m,
            center_n - radius_m,
            center_e + radius_m,
            center_n + radius_m,
        ),
        ZoneBoundsEnu::Polygon { vertices } => {
            let mut min_e = f64::INFINITY;
            let mut min_n = f64::INFINITY;
            let mut max_e = f64::NEG_INFINITY;
            let mut max_n = f64::NEG_INFINITY;
            for (e, n) in vertices {
                min_e = min_e.min(*e);
                min_n = min_n.min(*n);
                max_e = max_e.max(*e);
                max_n = max_n.max(*n);
            }
            if vertices.is_empty() {
                (0.0, 0.0, 0.0, 0.0)
            } else {
                (min_e, min_n, max_e, max_n)
            }
        }
    }
}

fn modality_color(m: SensorModality) -> [f32; 4] {
    match m {
        SensorModality::WifiCsi => [1.0, 0.2, 0.2, 1.0],
        SensorModality::MmWave => [1.0, 0.6, 0.1, 1.0],
        SensorModality::Uwb => [0.2, 0.45, 1.0, 1.0],
        SensorModality::Presence => [0.6, 0.6, 0.6, 1.0],
    }
}

fn anchor_label(k: AnchorKind) -> String {
    match k {
        AnchorKind::Reflector => "reflector",
        AnchorKind::Furniture => "furniture",
        AnchorKind::UwbBeacon => "uwb beacon",
    }
    .into()
}

/// Confidence → colour ramp: red (0.0) → green (1.0).
fn confidence_color(c: f32) -> [f32; 4] {
    let c = c.clamp(0.0, 1.0);
    [1.0 - c, c, 0.1, 1.0]
}

// ---- Provenance / click-to-audit (ADR-202 §4) ----

/// Assemble the audit card for a node id, or `None` if it is not in the graph.
#[must_use]
pub fn provenance_for(g: &WorldGraph, id: WorldId) -> Option<ProvenanceCard> {
    let node = g.node(id)?;
    let mut fields = Vec::new();
    let mut evidence = Vec::new();
    let (title, summary);

    match node {
        WorldNode::PersonTrack { track_id, last_position, reid_embedding_ref, .. } => {
            title = format!("Tracked person #{track_id}");
            summary = "Anonymous RF/ambient track — identity obfuscated; no video involved.".into();
            fields.push(kv("track_id", track_id.to_string()));
            fields.push(kv("last_position", enu_str(last_position)));
            fields.push(kv(
                "re_id",
                if reid_embedding_ref.is_some() { "embedding retained" } else { "none" }.into(),
            ));
            fields.push(kv("privacy", "identity obfuscated".into()));
        }
        WorldNode::ObjectAnchor { position, anchor_kind, confidence, .. } => {
            title = format!("Object anchor — {}", anchor_label(*anchor_kind));
            summary = format!(
                "Static {} anchor; confidence {:.0}%.",
                anchor_label(*anchor_kind),
                confidence * 100.0
            );
            fields.push(kv("kind", anchor_label(*anchor_kind)));
            fields.push(kv("confidence", format!("{:.2}", confidence)));
            fields.push(kv("position", enu_str(position)));
        }
        WorldNode::Room { area_id, name, floor, .. } => {
            title = format!("Room — {name}");
            summary = match area_id {
                Some(a) => format!("Geospatially grounded room linked to HomeCore area `{a}`."),
                None => "Room footprint; not yet linked to a HomeCore area.".into(),
            };
            fields.push(kv("name", name.clone()));
            fields.push(kv("area_id", area_id.clone().unwrap_or_else(|| "—".into())));
            fields.push(kv("floor", floor.to_string()));
        }
        WorldNode::Sensor { device_id, position, modality, .. } => {
            title = format!("Sensor — {device_id}");
            summary = format!("{} sensing node placed at install time.", modality_label(*modality));
            fields.push(kv("device_id", device_id.clone()));
            fields.push(kv("modality", modality_label(*modality)));
            fields.push(kv("position", enu_str(position)));
        }
        WorldNode::SemanticState { statement, confidence, provenance, valid_from_unix_ms, .. } => {
            title = "Semantic belief".into();
            summary = format!(
                "“{statement}” — fused via model {} (calibration {}) under privacy {}.",
                provenance.model_version, provenance.calibration_version, provenance.privacy_decision
            );
            fields.push(kv("statement", statement.clone()));
            fields.push(kv("confidence", format!("{:.2}", confidence)));
            fields.push(kv("model_version", provenance.model_version.clone()));
            fields.push(kv("calibration_version", provenance.calibration_version.clone()));
            fields.push(kv("privacy_decision", provenance.privacy_decision.clone()));
            fields.push(kv("valid_from_unix_ms", valid_from_unix_ms.to_string()));
            evidence.extend(provenance.evidence.iter().cloned());
        }
        WorldNode::Event { event_type, at_unix_ms, .. } => {
            title = format!("Event — {event_type}");
            summary = format!("Discrete `{event_type}` event at {at_unix_ms} (Unix ms).");
            fields.push(kv("event_type", event_type.clone()));
            fields.push(kv("at_unix_ms", at_unix_ms.to_string()));
        }
        other => {
            title = other.kind().to_string();
            summary = format!("{} node.", other.kind());
        }
    }

    // Walk outgoing `derived_from` / `contradicts` edges for provenance chain.
    for (_, edge) in g.neighbors(id) {
        match edge {
            WorldEdge::DerivedFrom { evidence: handle } if !handle.is_empty() => {
                evidence.push(handle);
            }
            WorldEdge::Contradicts { flag, magnitude } => {
                fields.push(kv("contradiction", format!("{flag} (mag {magnitude:.2})")));
            }
            _ => {}
        }
    }

    Some(ProvenanceCard { id: id.0, kind: node.kind().into(), title, summary, fields, evidence })
}

fn modality_label(m: SensorModality) -> String {
    match m {
        SensorModality::WifiCsi => "WiFi CSI",
        SensorModality::MmWave => "60 GHz mmWave",
        SensorModality::Uwb => "UWB",
        SensorModality::Presence => "presence",
    }
    .into()
}

fn enu_str(p: &EnuPoint) -> String {
    format!("E {:.2} m, N {:.2} m, U {:.2} m", p.east_m, p.north_m, p.up_m)
}

fn kv(k: &str, v: String) -> KeyVal {
    KeyVal { key: k.into(), value: v }
}

// ---- Visual configurator (ADR-202 §2) ----

/// A room authored by dragging a 3-D box gizmo in SuperSplat. Coordinates arrive
/// in PlayCanvas space and are projected back into the ENU frame for the RVF.
#[must_use]
pub fn room_from_box(
    area_id: Option<String>,
    name: &str,
    pc_center: [f64; 3],
    pc_size: [f64; 3],
    floor: i16,
) -> WorldNode {
    let c = pc_to_enu(pc_center);
    // PlayCanvas scale axes map to ENU extents: x→east, z→north (up ignored for 2-D footprint).
    let half_e = pc_size[0].abs() / 2.0;
    let half_n = pc_size[2].abs() / 2.0;
    WorldNode::Room {
        id: WorldId::UNASSIGNED,
        area_id,
        name: name.to_string(),
        bounds_enu: ZoneBoundsEnu::Rectangle {
            min_e: c.east_m - half_e,
            min_n: c.north_m - half_n,
            max_e: c.east_m + half_e,
            max_n: c.north_m + half_n,
        },
        floor,
    }
}

/// A sensor placed by dropping a marker where hardware was physically mounted.
#[must_use]
pub fn sensor_from_marker(device_id: &str, pc_pos: [f64; 3], modality: SensorModality) -> WorldNode {
    WorldNode::Sensor {
        id: WorldId::UNASSIGNED,
        device_id: device_id.to_string(),
        position: pc_to_enu(pc_pos),
        modality,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wifi_densepose_geo::GeoRegistration;

    fn enu(e: f64, n: f64) -> EnuPoint {
        EnuPoint { east_m: e, north_m: n, up_m: 0.0 }
    }

    fn sample_graph() -> WorldGraph {
        let mut g = WorldGraph::new(GeoRegistration::default());
        g.upsert_node(WorldNode::Room {
            id: WorldId::UNASSIGNED,
            area_id: Some("kitchen".into()),
            name: "Kitchen".into(),
            bounds_enu: ZoneBoundsEnu::Rectangle { min_e: 2.0, min_n: 0.0, max_e: 5.0, max_n: 4.0 },
            floor: 0,
        });
        g.upsert_node(WorldNode::Sensor {
            id: WorldId::UNASSIGNED,
            device_id: "esp32-a".into(),
            position: enu(1.0, 1.0),
            modality: SensorModality::WifiCsi,
        });
        g.upsert_node(WorldNode::PersonTrack {
            id: WorldId::UNASSIGNED,
            track_id: 42,
            last_position: enu(3.0, 2.0),
            reid_embedding_ref: None,
        });
        g
    }

    #[test]
    fn physical_filter_drops_abstract_nodes() {
        let mut g = sample_graph();
        let room = g.room_for_area("kitchen").unwrap();
        // A semantic belief should not be returned as a physical node.
        g.add_semantic_state(
            "present".into(),
            0.9,
            1,
            wifi_densepose_worldgraph::SemanticProvenance {
                evidence: vec![],
                model_version: "m".into(),
                calibration_version: "c".into(),
                privacy_decision: "p".into(),
            },
            &[room],
        );
        let phys = physical_nodes(&g).unwrap();
        assert!(phys.iter().all(is_physical));
        assert!(phys.iter().any(|n| matches!(n, WorldNode::Room { .. })));
        assert!(!phys.iter().any(|n| matches!(n, WorldNode::SemanticState { .. })));
    }

    #[test]
    fn room_primitive_centers_box_and_maps_enu() {
        let g = sample_graph();
        let prims = render_primitives(&g).unwrap();
        let room = prims.iter().find(|p| p.kind == "room").unwrap();
        assert_eq!(room.shape, PrimitiveShape::Box);
        // ENU centre (3.5, 2.0); PlayCanvas = (east, up, -north) = (3.5, h/2, -2.0).
        assert_eq!(room.position, [3.5, DEFAULT_ROOM_HEIGHT_M / 2.0, -2.0]);
        assert_eq!(room.scale, [3.0, DEFAULT_ROOM_HEIGHT_M, 4.0]);
        assert!(room.transparent);
    }

    #[test]
    fn person_avatar_is_anonymous_capsule_on_floor() {
        let g = sample_graph();
        let prims = render_primitives(&g).unwrap();
        let p = prims.iter().find(|p| p.kind == "person_track").unwrap();
        assert_eq!(p.shape, PrimitiveShape::Capsule);
        assert_eq!(p.label, "person #42");
        // Capsule lifted by half its height to stand on the floor.
        assert_eq!(p.position, [3.0, AVATAR_HEIGHT_M / 2.0, -2.0]);
    }

    #[test]
    fn sensor_primitive_uses_modality_colour() {
        let g = sample_graph();
        let prims = render_primitives(&g).unwrap();
        let s = prims.iter().find(|p| p.kind == "sensor").unwrap();
        assert_eq!(s.shape, PrimitiveShape::Sphere);
        assert_eq!(s.color, [1.0, 0.2, 0.2, 1.0]); // WifiCsi → red
    }

    #[test]
    fn provenance_card_for_person_is_anonymous() {
        let g = sample_graph();
        let nodes = nodes(&g).unwrap();
        let pid = nodes
            .iter()
            .find_map(|n| match n {
                WorldNode::PersonTrack { id, .. } => Some(*id),
                _ => None,
            })
            .unwrap();
        let card = provenance_for(&g, pid).unwrap();
        assert_eq!(card.kind, "person_track");
        assert!(card.summary.contains("identity obfuscated"));
        assert!(card.fields.iter().any(|f| f.key == "privacy"));
    }

    #[test]
    fn provenance_card_collects_semantic_evidence_chain() {
        let mut g = sample_graph();
        let room = g.room_for_area("kitchen").unwrap();
        let sid = g.add_semantic_state(
            "occupied".into(),
            0.8,
            123,
            wifi_densepose_worldgraph::SemanticProvenance {
                evidence: vec!["ev:room-csi".into()],
                model_version: "rfenc-2.1".into(),
                calibration_version: "cal:xyz".into(),
                privacy_decision: "PrivateHome/Allow".into(),
            },
            &[room],
        );
        let card = provenance_for(&g, sid).unwrap();
        assert!(card.summary.contains("rfenc-2.1"));
        assert!(card.evidence.contains(&"ev:room-csi".to_string()));
        assert!(card.fields.iter().any(|f| f.key == "calibration_version"));
    }

    #[test]
    fn configurator_box_round_trips_to_enu_rectangle() {
        // Drag a 4 m × 3 m box centred at PlayCanvas (3.5, 1.25, -2.0).
        let node = room_from_box(Some("den".into()), "Den", [3.5, 1.25, -2.0], [4.0, 2.5, 3.0], 1);
        match node {
            WorldNode::Room { bounds_enu: ZoneBoundsEnu::Rectangle { min_e, min_n, max_e, max_n }, floor, .. } => {
                // PlayCanvas centre (3.5, _, -2.0) → ENU (E 3.5, N 2.0). Extents east=4, north=3.
                assert_eq!((min_e, max_e), (1.5, 5.5));
                assert_eq!((min_n, max_n), (0.5, 3.5));
                assert_eq!(floor, 1);
            }
            other => panic!("expected room rectangle, got {other:?}"),
        }
    }

    #[test]
    fn configurator_marker_round_trips_to_enu_sensor() {
        let node = sensor_from_marker("esp32-c6", [1.0, 1.2, -2.0], SensorModality::Uwb);
        match node {
            WorldNode::Sensor { position, modality, device_id, .. } => {
                assert_eq!(device_id, "esp32-c6");
                assert_eq!(position.east_m, 1.0);
                assert_eq!(position.north_m, 2.0); // -(-2.0)
                assert_eq!(position.up_m, 1.2);
                assert!(matches!(modality, SensorModality::Uwb));
            }
            other => panic!("expected sensor, got {other:?}"),
        }
    }

    #[test]
    fn edges_decode_from_snapshot() {
        let mut g = sample_graph();
        let room = g.room_for_area("kitchen").unwrap();
        let nodes_v = nodes(&g).unwrap();
        let sensor = nodes_v
            .iter()
            .find_map(|n| match n {
                WorldNode::Sensor { id, .. } => Some(*id),
                _ => None,
            })
            .unwrap();
        g.add_edge(sensor, room, WorldEdge::Observes { quality: 0.9, last_seen_unix_ms: 1 })
            .unwrap();
        let es = edges(&g).unwrap();
        assert!(es
            .iter()
            .any(|(f, t, e)| *f == sensor && *t == room && matches!(e, WorldEdge::Observes { .. })));
    }
}
