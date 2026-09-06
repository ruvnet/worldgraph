import type { EntityState, WorldFrame } from '../contracts';
import { ENTITY_IDS, MAX_EVENTS_PER_BRANCH, RF_ROOM_BOUNDS, SCENE_BOUNDS, SCENARIOS, TIMELINE_DURATION } from './timeline';

/** The actual wasm-bindgen surface in worldgraph-wasm/src/bridge.rs. */
export interface RustWorldgraphBridge {
  nodeCount(): number;
  applyMessageJson(json: string): void;
  exportRvfJson(): string;
  free?(): void;
}
export interface WorldgraphWasmModule {
  default(input?: unknown): Promise<unknown>;
  WorldgraphBridge: { empty(): RustWorldgraphBridge };
}
export type WorldgraphLoader = () => Promise<WorldgraphWasmModule>;
export type GraphStatus = 'idle' | 'loading' | 'ready' | 'unavailable' | 'disposed';

/** Stable IDs belong to the graph, independent of array order or WASM handles. */
export const GRAPH_IDS = Object.freeze({
  room: 1, rfRoom: 2,
  'robot-1': 101, 'amr-1': 102, 'drone-1': 103, 'rf-door': 104, 'sensor-1': 105, 'sensor-2': 106,
});
const ENTITY_KINDS = ['robot', 'amr', 'drone', 'door', 'sensor', 'sensor'] as const;
// Explicit synthetic replay epoch, never represented as an observation timestamp.
export const REPLAY_EPOCH_UNIX_MS = Date.UTC(2026, 0, 1);
const METADATA_VERSION = 'rulab-analytic-kinematics-v1';

export const loadWorldgraphWasm: WorldgraphLoader = async () => {
  if (typeof document === 'undefined') throw new Error('Browser WASM loader requires a document; inject a loader in Node');
  const base = (import.meta as ImportMeta & { env?: { BASE_URL?: string } }).env?.BASE_URL ?? './';
  const moduleUrl = new URL(`${base}wasm/worldgraph_wasm.js`, document.baseURI).href;
  return await import(/* @vite-ignore */ moduleUrl) as WorldgraphWasmModule;
};

function finite(value: unknown, low: number, high: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= low && value <= high;
}

/** Reject unsupported provenance instead of silently labelling captured input as authored. */
function validateFrame(frame: WorldFrame): void {
  if (!frame || frame.version !== 1 || !SCENARIOS.includes(frame.scenario) ||
      !finite(frame.time, 0, TIMELINE_DURATION) || !Number.isSafeInteger(frame.revision) || frame.revision < 0 ||
      !Array.isArray(frame.entities) || frame.entities.length !== ENTITY_IDS.length ||
      !Array.isArray(frame.events) || frame.events.length > MAX_EVENTS_PER_BRANCH) throw new TypeError('Invalid RuLab WorldFrame');
  const seen = new Set<string>();
  for (const entity of frame.entities) {
    if (!entity || typeof entity.id !== 'string') throw new TypeError('Invalid graph entity');
    const index = ENTITY_IDS.indexOf(entity.id as typeof ENTITY_IDS[number]);
    if (index < 0 || seen.has(entity.id) || entity.kind !== ENTITY_KINDS[index] ||
        entity.source !== 'authored' || !finite(entity.confidence, 0, 1) ||
        typeof entity.label !== 'string' || entity.label.length > 160 ||
        !Array.isArray(entity.position) || entity.position.length !== 3 ||
        !finite(entity.position[0], SCENE_BOUNDS.minEast, SCENE_BOUNDS.maxEast) ||
        !finite(entity.position[1], SCENE_BOUNDS.minNorth, SCENE_BOUNDS.maxNorth) ||
        !finite(entity.position[2], 0, SCENE_BOUNDS.ceiling) || !finite(entity.yaw, -Math.PI * 2, Math.PI * 2) ||
        !Array.isArray(entity.joints) || entity.joints.length > 8 || entity.joints.some(joint => !finite(joint, -Math.PI * 2, Math.PI * 2))) {
      throw new TypeError('Invalid or unsupported RuLab graph entity');
    }
    seen.add(entity.id);
  }
}

const enu = ([east_m, north_m, up_m]: EntityState['position']) => ({ east_m, north_m, up_m });
type Node = Record<string, unknown>;

function physicalNode(entity: EntityState): Node {
  const id = GRAPH_IDS[entity.id as typeof ENTITY_IDS[number]];
  if (entity.kind === 'sensor') return { kind: 'sensor', id, device_id: entity.id,
    position: enu(entity.position), modality: entity.id === 'sensor-1' ? 'uwb' : 'wifi_csi' };
  if (entity.kind === 'door') return { kind: 'doorway', id, center: enu(entity.position), width_m: 2.4 };
  // The current Rust schema has no articulated robot node. An ObjectAnchor is the
  // render-compatible pose projection; exact kind, joints and source live in its
  // associated SemanticState rather than being discarded or invented in Rust.
  return { kind: 'object_anchor', id, position: enu(entity.position), anchor_kind: 'reflector', confidence: entity.confidence };
}

function provenanceNode(entity: EntityState, frame: WorldFrame): Node {
  return { kind: 'semantic_state', id: GRAPH_IDS[entity.id as typeof ENTITY_IDS[number]] + 100,
    statement: JSON.stringify({ schema: 'worldgraph.rulab.entity.v1', entityId: entity.id, kind: entity.kind,
      label: entity.label, source: entity.source, scenario: frame.scenario, positionENU: entity.position,
      yawRadians: entity.yaw, jointsRadians: entity.joints, replaySeconds: frame.time, revision: frame.revision }),
    confidence: entity.confidence,
    provenance: {
      evidence: [`ruv://worldgraph/rulab/${frame.scenario}/authored-layout-v1`],
      model_version: METADATA_VERSION,
      calibration_version: 'rulab-concept-enu-v1-not-surveyed',
      privacy_decision: 'synthetic:no-personal-data',
    },
    valid_from_unix_ms: REPLAY_EPOCH_UNIX_MS + Math.round(frame.time * 1000),
  };
}

/**
 * Browser adapter backed exclusively by the repository's Rust WASM graph.
 * Initialization failure is explicit. There is no JavaScript graph substitute.
 * Call sync at the semantic update cadence, independently of the render rate.
 */
export class RuLabGraph {
  private bridge: RustWorldgraphBridge | null = null;
  private pending: Promise<void> | null = null;
  private generation = 0;
  private applied = new Map<number, string>();
  status: GraphStatus = 'idle';
  error: string | null = null;

  get ready(): boolean { return this.status === 'ready' && this.bridge !== null; }

  initialize(loader: WorldgraphLoader = loadWorldgraphWasm): Promise<void> {
    if (this.status === 'disposed') return Promise.reject(new Error('RuLab graph has been disposed'));
    if (this.ready) return Promise.resolve();
    if (this.pending) return this.pending;
    this.status = 'loading';
    this.error = null;
    const generation = ++this.generation;
    const pending = (async () => {
      const module = await loader();
      if (typeof module.default !== 'function' || typeof module.WorldgraphBridge?.empty !== 'function') throw new Error('Invalid WorldGraph WASM module');
      await module.default();
      if (generation !== this.generation) throw new Error('RuLab graph initialization was cancelled');
      this.bridge = module.WorldgraphBridge.empty();
      this.status = 'ready';
    })().catch((error: unknown) => {
      if (generation === this.generation) {
        this.status = 'unavailable';
        this.error = error instanceof Error ? error.message : String(error);
        this.bridge = null;
      }
      throw error;
    }).finally(() => { if (this.pending === pending) this.pending = null; });
    this.pending = pending;
    return pending;
  }

  private require(): RustWorldgraphBridge {
    if (!this.ready || !this.bridge) throw new Error(`WorldGraph WASM is ${this.status}; initialize it before use`);
    return this.bridge;
  }

  sync(frame: WorldFrame): void {
    const bridge = this.require();
    validateFrame(frame);
    const { minEast, maxEast, minNorth, maxNorth } = SCENE_BOUNDS;
    const nodes: Node[] = [
      { kind: 'room', id: GRAPH_IDS.room, area_id: `rulab:${frame.scenario}`, name: `RuLab ${frame.scenario} concept`,
        bounds_enu: { shape: 'rectangle', min_e: minEast, max_e: maxEast, min_n: minNorth, max_n: maxNorth }, floor: 0 },
      { kind: 'room', id: GRAPH_IDS.rfRoom, area_id: 'rulab:rf-chamber', name: 'Authored RF chamber',
        bounds_enu: { shape: 'rectangle', min_e: RF_ROOM_BOUNDS.minEast, max_e: RF_ROOM_BOUNDS.maxEast,
          min_n: RF_ROOM_BOUNDS.minNorth, max_n: RF_ROOM_BOUNDS.maxNorth }, floor: 0 },
      ...frame.entities.map(physicalNode),
      ...frame.entities.map(entity => provenanceNode(entity, frame)),
    ];
    try {
      for (const node of nodes) {
        const id = node.id as number;
        const json = JSON.stringify({ op: 'upsert_node', node });
        if (this.applied.get(id) === json) continue;
        bridge.applyMessageJson(json);
        this.applied.set(id, json);
      }
      for (const entity of frame.entities) {
        const id = GRAPH_IDS[entity.id as typeof ENTITY_IDS[number]];
        // Stable edge IDs prevent duplicate relationships on each animation frame.
        this.applyEdge(id + 1000, id, entity.kind === 'door' ? GRAPH_IDS.rfRoom : GRAPH_IDS.room,
          { rel: 'located_in', since_unix_ms: REPLAY_EPOCH_UNIX_MS });
        this.applyEdge(id + 2000, id + 100, id,
          { rel: 'derived_from', evidence: `ruv://worldgraph/rulab/${frame.scenario}/authored-layout-v1` });
      }
      this.applyEdge(3001, GRAPH_IDS.room, GRAPH_IDS.rfRoom, { rel: 'adjacent_to', via_doorway: GRAPH_IDS['rf-door'] });
      this.applyEdge(3002, GRAPH_IDS.rfRoom, GRAPH_IDS.room, { rel: 'adjacent_to', via_doorway: GRAPH_IDS['rf-door'] });
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      this.status = 'unavailable';
      this.bridge = null;
      this.applied.clear();
      bridge.free?.();
      throw new Error(`WorldGraph WASM update failed: ${this.error}`, { cause: error });
    }
  }

  private applyEdge(id: number, from: number, to: number, edge: Record<string, unknown>): void {
    const json = JSON.stringify({ op: 'upsert_edge', id, from, to, edge });
    if (this.applied.get(id) === json) return;
    this.require().applyMessageJson(json);
    this.applied.set(id, json);
  }

  nodeCount(): number { return this.require().nodeCount(); }
  exportJson(): string { return this.require().exportRvfJson(); }

  dispose(): void {
    ++this.generation;
    this.bridge?.free?.();
    this.bridge = null;
    this.applied.clear();
    this.status = 'disposed';
  }
}
