// A dependency-free, in-memory fake of the Rust `WorldgraphBridge`, used to test
// the TypeScript layers without compiling WASM or running a browser. It mimics
// the observable behaviour the TS code relies on (id allocation, upsert-by-id,
// removal, provenance lookup) — NOT the full Rust semantics.

import type {
  ProvenanceCard,
  RenderPrimitive,
  SensorModality,
  TrajectoryStep,
  WorldEdgeTriple,
  WorldNode
} from '../src/types.js';
import type {
  WorldgraphBridgeApi,
  WorldgraphWasmModule
} from '../src/wasm-bridge.js';
import { buildTrajectoryOverlay } from '../src/usecases/occworld.js';

export class FakeBridge implements WorldgraphBridgeApi {
  private nodes = new Map<number, WorldNode>();
  private nextId = 1;

  constructor(seed: WorldNode[] = []) {
    for (const n of seed) {
      this.nodes.set(n.id, n);
      this.nextId = Math.max(this.nextId, n.id + 1);
    }
  }

  nodeCount(): number {
    return this.nodes.size;
  }

  getAllNodes(): WorldNode[] {
    return [...this.nodes.values()];
  }

  getSemanticNodes(): WorldNode[] {
    const physical = new Set(['room', 'zone', 'wall', 'doorway', 'sensor', 'person_track', 'object_anchor']);
    return this.getAllNodes().filter((n) => physical.has(n.kind));
  }

  getEdges(): WorldEdgeTriple[] {
    return [];
  }

  getRenderPrimitives(): RenderPrimitive[] {
    // Minimal: one sphere per node, enough for reconciler plumbing tests.
    return this.getSemanticNodes().map((n) => ({
      id: n.id,
      kind: n.kind,
      shape: 'sphere',
      label: n.kind,
      position: [0, 0, 0],
      scale: [1, 1, 1],
      color: [1, 1, 1, 1],
      transparent: false
    }));
  }

  getProvenance(id: number): ProvenanceCard | null {
    const n = this.nodes.get(id);
    if (!n) return null;
    return {
      id,
      kind: n.kind,
      title: `${n.kind} #${id}`,
      summary: n.kind === 'person_track' ? 'identity obfuscated' : `${n.kind} node`,
      fields: [{ key: 'kind', value: n.kind }],
      evidence: []
    };
  }

  trajectoryOverlay(trackId: number, fromE: number, fromN: number, fromU: number, steps: TrajectoryStep[]): RenderPrimitive[] {
    return buildTrajectoryOverlay(trackId, { east_m: fromE, north_m: fromN, up_m: fromU }, steps);
  }

  upsertPerson(id: number, trackId: number, e: number, n: number, u: number): number {
    const worldId = id === 0 ? this.nextId++ : id;
    this.nodes.set(worldId, {
      kind: 'person_track',
      id: worldId,
      track_id: trackId,
      last_position: { east_m: e, north_m: n, up_m: u },
      reid_embedding_ref: null
    });
    return worldId;
  }

  removeNode(id: number): boolean {
    return this.nodes.delete(id);
  }

  addRoomFromBox(name: string, areaId: string | null, cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, floor: number): number {
    const id = this.nextId++;
    const halfE = Math.abs(sx) / 2;
    const halfN = Math.abs(sz) / 2;
    this.nodes.set(id, {
      kind: 'room',
      id,
      area_id: areaId,
      name,
      bounds_enu: { shape: 'rectangle', min_e: cx - halfE, min_n: -cz - halfN, max_e: cx + halfE, max_n: -cz + halfN },
      floor
    });
    return id;
  }

  addSensorFromMarker(deviceId: string, x: number, y: number, z: number, modality: string): number {
    const id = this.nextId++;
    this.nodes.set(id, {
      kind: 'sensor',
      id,
      device_id: deviceId,
      position: { east_m: x, north_m: -z, up_m: y },
      modality: modality as SensorModality
    });
    return id;
  }

  exportRvfJson(): string {
    return JSON.stringify({ schema_version: 1, nodes: this.getAllNodes(), edges: [] });
  }
}

/** A fake `wasm-pack` module that hands back {@link FakeBridge} instances. */
export function makeFakeModule(seed: WorldNode[] = []): WorldgraphWasmModule {
  return {
    default: async () => undefined,
    WorldgraphBridge: Object.assign(
      function (this: unknown, _rvfJson: string) {
        return new FakeBridge(seed);
      } as unknown as WorldgraphWasmModule['WorldgraphBridge'],
      { empty: () => new FakeBridge(seed) }
    )
  };
}
