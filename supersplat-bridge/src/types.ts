// ADR-200 — TypeScript mirror of the WorldGraph serde wire format.
//
// These types match the *actual* serde representation of
// `wifi-densepose-worldgraph`, NOT the aspirational shapes from early design
// sketches. Concretely:
//   • the node discriminant is `kind` (snake_case), not `type`;
//   • points are `{ east_m, north_m, up_m }`, not `{ east, north, up }`;
//   • `bounds_enu` is a `{ shape, … }` union, not a `{ center, size }` object;
//   • `WorldId` is a serde newtype → a bare `number` on the wire.
// Keep this file in lockstep with `model.rs` / `graph.rs`.

/** Local ENU coordinate (metres) relative to the installation origin. */
export interface EnuPoint {
  east_m: number;
  north_m: number;
  up_m: number;
}

/** A room/zone footprint in the ENU frame, tagged by `shape`. */
export type ZoneBoundsEnu =
  | { shape: 'rectangle'; min_e: number; min_n: number; max_e: number; max_n: number }
  | { shape: 'circle'; center_e: number; center_n: number; radius_m: number }
  | { shape: 'polygon'; vertices: Array<[number, number]> };

/** Sensing modality (serde snake_case of the Rust enum). */
export type SensorModality = 'wifi_csi' | 'mm_wave' | 'uwb' | 'presence';

/** Static anchor classification. */
export type AnchorKind = 'reflector' | 'furniture' | 'uwb_beacon';

/** Mandatory provenance carried by every semantic belief. */
export interface SemanticProvenance {
  evidence: string[];
  model_version: string;
  calibration_version: string;
  privacy_decision: string;
}

/** A typed world node — discriminated union on `kind`. */
export type WorldNode =
  | { kind: 'room'; id: number; area_id: string | null; name: string; bounds_enu: ZoneBoundsEnu; floor: number }
  | { kind: 'zone'; id: number; parent_room: number; name: string; bounds_enu: ZoneBoundsEnu }
  | { kind: 'wall'; id: number; a: EnuPoint; b: EnuPoint; rf_attenuation_db: number }
  | { kind: 'doorway'; id: number; center: EnuPoint; width_m: number }
  | { kind: 'sensor'; id: number; device_id: string; position: EnuPoint; modality: SensorModality }
  | { kind: 'rf_link'; id: number; tx: number; rx: number; link_group_id: string | null; center_freq_mhz: number }
  | { kind: 'person_track'; id: number; track_id: number; last_position: EnuPoint; reid_embedding_ref: string | null }
  | { kind: 'object_anchor'; id: number; position: EnuPoint; anchor_kind: AnchorKind; confidence: number }
  | { kind: 'event'; id: number; event_type: string; at_unix_ms: number; located_in: number | null }
  | { kind: 'semantic_state'; id: number; statement: string; confidence: number; provenance: SemanticProvenance; valid_from_unix_ms: number };

/** A typed edge — discriminated union on `rel`. */
export type WorldEdge =
  | { rel: 'observes'; quality: number; last_seen_unix_ms: number }
  | { rel: 'located_in'; since_unix_ms: number }
  | { rel: 'adjacent_to'; via_doorway: number }
  | { rel: 'supports'; strength: number }
  | { rel: 'contradicts'; magnitude: number; flag: string }
  | { rel: 'derived_from'; evidence: string }
  | { rel: 'privacy_limited_by'; mode: string; action: string; allowed: boolean };

/** Edge as serialized by the snapshot: `[fromId, toId, edge]`. */
export type WorldEdgeTriple = [number, number, WorldEdge];

/** Drawable shape for a render primitive (1:1 with a PlayCanvas render type). */
export type PrimitiveShape = 'box' | 'sphere' | 'cylinder' | 'capsule' | 'line';

/** RGBA, each component in 0..1. */
export type Rgba = [number, number, number, number];
/** PlayCanvas position/scale `[x, y, z]` (metres). */
export type Vec3 = [number, number, number];

/**
 * A fully ENU-mapped, render-ready primitive produced by the Rust core. The
 * frontend instantiates these verbatim — it never re-derives coordinates.
 */
export interface RenderPrimitive {
  id: number;
  kind: string;
  shape: PrimitiveShape;
  label: string;
  /** PlayCanvas position [x, y, z]. */
  position: Vec3;
  /** PlayCanvas local scale [x, y, z]. */
  scale: Vec3;
  color: Rgba;
  /** Endpoint for `line` primitives. */
  to?: Vec3;
  transparent: boolean;
}

/** One row of a provenance / audit card. */
export interface KeyVal {
  key: string;
  value: string;
}

/** Click-to-audit payload: why the system believes a node exists. */
export interface ProvenanceCard {
  id: number;
  kind: string;
  title: string;
  summary: string;
  fields: KeyVal[];
  evidence: string[];
}

/** One predicted OccWorld trajectory step. */
export interface TrajectoryStep {
  point: EnuPoint;
  probability: number;
}
