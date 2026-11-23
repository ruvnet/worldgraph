import { loadWorldgraphWasm, type GraphStatus, type RustWorldgraphBridge, type WorldgraphLoader } from '../world/graph';

export const HYBRID_ACTOR_IDS = Object.freeze(['coast-walker-1', 'coast-walker-2', 'coast-vehicle-1'] as const);
export const ACTOR_IDS = HYBRID_ACTOR_IDS;
export type HybridActorId = typeof HYBRID_ACTOR_IDS[number];
export interface HybridActorState {
  id: string;
  /** Three.js local metres, with Y up. */
  position: [number, number, number];
  /** Actor yaw about the positive Three.js Y axis, in radians. */
  heading: number;
}

/** Disjoint from the lab, capture and model rollout namespaces. */
export const HYBRID_GRAPH_IDS = Object.freeze({
  room: 43000,
  'coast-walker-1': 43001,
  'coast-walker-2': 43002,
  'coast-vehicle-1': 43003,
});
export const HYBRID_MAX_TIME_SECONDS = 86_400;
export const HYBRID_SCENE_BOUNDS = Object.freeze({ minX: -200, maxX: 200, minY: 0, maxY: 90, minZ: -180, maxZ: 180 });
/** Required Rust validity value, not a wall clock or an observation timestamp. */
export const HYBRID_VALIDITY_EPOCH_UNIX_MS = 0;
const SOURCE = 'ruv://worldgraph/rulab/coastal/authored-layout-v1';

function finite(value: unknown, low: number, high: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= low && value <= high;
}

function checkedActors(timeSeconds: number, actors: HybridActorState[]): HybridActorState[] {
  if (!finite(timeSeconds, 0, HYBRID_MAX_TIME_SECONDS)) throw new TypeError('Invalid synthetic playback time.');
  if (!Array.isArray(actors) || actors.length !== HYBRID_ACTOR_IDS.length) throw new TypeError('Exactly three known coastal actors are required.');
  const checked = new Map<HybridActorId, HybridActorState>();
  const b = HYBRID_SCENE_BOUNDS;
  for (const actor of actors) {
    if (!actor || typeof actor !== 'object' || Array.isArray(actor) ||
        !HYBRID_ACTOR_IDS.includes(actor.id as HybridActorId) || checked.has(actor.id as HybridActorId) ||
        !Array.isArray(actor.position) || actor.position.length !== 3 ||
        !finite(actor.position[0], b.minX, b.maxX) || !finite(actor.position[1], b.minY, b.maxY) ||
        !finite(actor.position[2], b.minZ, b.maxZ) || !finite(actor.heading, -2 * Math.PI, 2 * Math.PI)) {
      throw new TypeError('Invalid coastal actor identity, position or heading.');
    }
    // Copy validated primitives; later caller mutation cannot change a pending projection.
    checked.set(actor.id as HybridActorId, { id: actor.id, position: [...actor.position], heading: actor.heading });
  }
  return HYBRID_ACTOR_IDS.map(id => checked.get(id)!);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function release(bridge: RustWorldgraphBridge | null): string | null {
  try { bridge?.free?.(); return null; } catch (error) { return errorMessage(error); }
}

/**
 * Separate Rust WASM graph for an authored coastal demonstration. No sensor,
 * captured or predictive graph instance is accepted or mutated by this adapter.
 * A transform proxy does not establish an observation or metric registration.
 */
export class HybridGraph {
  private bridge: RustWorldgraphBridge | null = null;
  private pending: Promise<void> | null = null;
  private generation = 0;
  private applied = new Map<number, string>();
  status: GraphStatus = 'idle';
  error: string | null = null;

  get ready(): boolean { return this.status === 'ready' && this.bridge !== null; }

  initialize(loader: WorldgraphLoader = loadWorldgraphWasm): Promise<void> {
    if (this.status === 'disposed') return Promise.reject(new Error('Hybrid graph has been disposed.'));
    if (this.ready) return Promise.resolve();
    if (this.pending) return this.pending;
    this.status = 'loading'; this.error = null;
    const generation = ++this.generation;
    let candidate: RustWorldgraphBridge | null = null;
    const pending = (async () => {
      const module = await loader();
      if (generation !== this.generation) throw new Error('Hybrid graph initialization was cancelled.');
      if (typeof module?.default !== 'function' || typeof module?.WorldgraphBridge?.empty !== 'function') {
        throw new Error('Invalid WorldGraph WASM module.');
      }
      await module.default();
      if (generation !== this.generation) throw new Error('Hybrid graph initialization was cancelled.');
      candidate = module.WorldgraphBridge.empty();
      if (!candidate || typeof candidate.nodeCount !== 'function' || typeof candidate.applyMessageJson !== 'function' ||
          typeof candidate.exportRvfJson !== 'function') throw new Error('Invalid WorldGraph WASM bridge.');
      if (generation !== this.generation) throw new Error('Hybrid graph initialization was cancelled.');
      this.bridge = candidate; candidate = null; this.applied.clear(); this.status = 'ready';
    })().catch((error: unknown) => {
      const releaseError = release(candidate);
      if (generation === this.generation) {
        this.status = 'unavailable'; this.error = errorMessage(error);
        if (releaseError) this.error += `; WASM release failed: ${releaseError}`;
        this.bridge = null;
      }
      throw error;
    }).finally(() => { if (this.pending === pending) this.pending = null; });
    this.pending = pending;
    return pending;
  }

  private require(): RustWorldgraphBridge {
    if (!this.ready || !this.bridge) throw new Error(`Hybrid WorldGraph WASM is ${this.status}; initialize it before use.`);
    return this.bridge;
  }

  /** Call at the semantic update cadence, independently of the display frame rate. */
  sync(timeSeconds: number, actors: HybridActorState[]): void {
    const bridge = this.require();
    const values = checkedActors(timeSeconds, actors);
    const nodes: Record<string, unknown>[] = [{
      kind: 'room', id: HYBRID_GRAPH_IDS.room, area_id: null, name: 'Synthetic coastal demonstration; not surveyed',
      bounds_enu: { shape: 'rectangle', min_e: HYBRID_SCENE_BOUNDS.minX, max_e: HYBRID_SCENE_BOUNDS.maxX,
        min_n: -HYBRID_SCENE_BOUNDS.maxZ, max_n: -HYBRID_SCENE_BOUNDS.minZ }, floor: 0,
    }];
    for (const actor of values) {
      const id = HYBRID_GRAPH_IDS[actor.id as HybridActorId];
      const [x, y, z] = actor.position;
      const positionENU = [x, -z, y];
      // Rust currently has no generic animated-object node. This confidence-zero
      // ObjectAnchor is a schema-compatible transform proxy, not an RF reflector.
      nodes.push({ kind: 'object_anchor', id, position: { east_m: x, north_m: -z, up_m: y }, anchor_kind: 'reflector', confidence: 0 });
      nodes.push({ kind: 'semantic_state', id: id + 100, confidence: 0,
        statement: JSON.stringify({ schema: 'worldgraph.rulab.coastal.actor.v1', entityId: actor.id,
          kind: actor.id === 'coast-vehicle-1' ? 'vehicle' : 'walker', source: 'synthetic', simulated: true,
          motion: 'analytic', classification: 'authored-scene-not-a-capture', replaySeconds: timeSeconds,
          positionENU, positionRenderYUp: actor.position, headingRadians: actor.heading,
          headingBasis: 'rotation-about-positive-render-y-axis', units: 'metres',
          registration: 'authored-local-frame-not-surveyed',
          anchorMeaning: 'schema-compatible authored transform proxy; no RF observation',
          confidenceMeaning: 'zero: sensing and reconstruction accuracy are not assessed',
          validityEpoch: 'schema-placeholder-unix-zero-not-observation-time' }),
        provenance: { evidence: [SOURCE], model_version: 'rulab-coastal-analytic-v1-no-learned-model',
          calibration_version: 'authored-enu-v1-not-surveyed', privacy_decision: 'synthetic:no-personal-data' },
        valid_from_unix_ms: HYBRID_VALIDITY_EPOCH_UNIX_MS });
    }
    const updates = nodes.map(node => ({ id: node.id as number, json: JSON.stringify({ op: 'upsert_node', node }) }));
    for (const actor of values) {
      const id = HYBRID_GRAPH_IDS[actor.id as HybridActorId];
      updates.push({ id: id + 1000, json: JSON.stringify({ op: 'upsert_edge', id: id + 1000, from: id, to: HYBRID_GRAPH_IDS.room,
        edge: { rel: 'located_in', since_unix_ms: HYBRID_VALIDITY_EPOCH_UNIX_MS } }) });
      updates.push({ id: id + 2000, json: JSON.stringify({ op: 'upsert_edge', id: id + 2000, from: id + 100, to: id,
        edge: { rel: 'derived_from', evidence: SOURCE } }) });
    }
    try {
      for (const { id, json } of updates) {
        if (this.applied.get(id) === json) continue;
        bridge.applyMessageJson(json); this.applied.set(id, json);
      }
    } catch (error) {
      this.error = errorMessage(error); this.status = 'unavailable'; this.bridge = null; this.applied.clear();
      const releaseError = release(bridge);
      if (releaseError) this.error += `; WASM release failed: ${releaseError}`;
      throw new Error(`Hybrid WorldGraph WASM update failed: ${this.error}`, { cause: error });
    }
  }

  nodeCount(): number { return this.require().nodeCount(); }
  exportJson(): string { return this.require().exportRvfJson(); }

  dispose(): void {
    ++this.generation;
    const bridge = this.bridge;
    this.bridge = null; this.applied.clear(); this.status = 'disposed';
    const releaseError = release(bridge);
    if (releaseError) this.error = `WASM release failed: ${releaseError}`;
  }
}
