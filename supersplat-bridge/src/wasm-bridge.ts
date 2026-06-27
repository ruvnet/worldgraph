// ADR-200 §2 — the TypeScript wrapper around the generated WASM module.
//
// `SemanticVisualizer` owns one `WorldgraphBridge` instance and exposes a typed,
// promise-friendly API. The WASM module is *injected* (not hard-imported) so the
// class is unit-testable against a mock that satisfies `WorldgraphBridgeApi`
// without a browser — and so the real `wasm-pack` output path is a deployment
// detail rather than a compile-time dependency.

import type {
  ProvenanceCard,
  RenderPrimitive,
  SensorModality,
  TrajectoryStep,
  WorldEdgeTriple,
  WorldNode
} from './types.js';

/** The instance surface of the Rust `WorldgraphBridge` (camelCase js_names). */
export interface WorldgraphBridgeApi {
  nodeCount(): number;
  getSemanticNodes(): WorldNode[];
  getAllNodes(): WorldNode[];
  getEdges(): WorldEdgeTriple[];
  getRenderPrimitives(): RenderPrimitive[];
  getProvenance(id: number): ProvenanceCard | null;
  trajectoryOverlay(
    trackId: number,
    fromE: number,
    fromN: number,
    fromU: number,
    steps: TrajectoryStep[]
  ): RenderPrimitive[];
  upsertPerson(id: number, trackId: number, e: number, n: number, u: number): number;
  removeNode(id: number): boolean;
  addRoomFromBox(
    name: string,
    areaId: string | null,
    cx: number,
    cy: number,
    cz: number,
    sx: number,
    sy: number,
    sz: number,
    floor: number
  ): number;
  addSensorFromMarker(deviceId: string, x: number, y: number, z: number, modality: string): number;
  exportRvfJson(): string;
}

/** Constructor + static factory of the Rust `WorldgraphBridge` class. */
export interface WorldgraphBridgeCtor {
  new (rvfJson: string): WorldgraphBridgeApi;
  empty(): WorldgraphBridgeApi;
}

/** The generated `wasm-pack --target web` module shape. */
export interface WorldgraphWasmModule {
  /** Initializes the WASM instance (idempotent in practice). */
  default(input?: unknown): Promise<unknown>;
  WorldgraphBridge: WorldgraphBridgeCtor;
}

/** How `SemanticVisualizer` obtains the WASM module. */
export type WasmLoader = () => Promise<WorldgraphWasmModule>;

/**
 * Default loader: dynamically imports the `wasm-pack` output. The path is
 * resolved at call time so bundlers that cannot see the (build-time generated)
 * module do not fail to type-check this package.
 */
export const defaultWasmLoader: WasmLoader = async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod = (await import(
    /* @vite-ignore */ './worldgraph-wasm/worldgraph_wasm.js' as string
  )) as unknown as WorldgraphWasmModule;
  return mod;
};

export interface InitOptions {
  /** RVF/JSON twin payload. Omit to start an empty graph (configurator mode). */
  rvfJson?: string;
  /** Override the WASM loader (tests inject a mock module here). */
  loader?: WasmLoader;
}

/**
 * Browser-side facade over the WorldGraph WASM twin.
 *
 * ```ts
 * const viz = new SemanticVisualizer();
 * await viz.initialize({ rvfJson });
 * scene.sync(viz.renderPrimitives());
 * ```
 */
export class SemanticVisualizer {
  private bridge: WorldgraphBridgeApi | null = null;

  /** Whether {@link initialize} has completed. */
  get ready(): boolean {
    return this.bridge !== null;
  }

  /** Load the WASM module and construct the twin (from payload or empty). */
  async initialize(opts: InitOptions = {}): Promise<void> {
    const loader = opts.loader ?? defaultWasmLoader;
    const mod = await loader();
    await mod.default();
    this.bridge =
      opts.rvfJson === undefined
        ? mod.WorldgraphBridge.empty()
        : new mod.WorldgraphBridge(opts.rvfJson);
  }

  private require(): WorldgraphBridgeApi {
    if (!this.bridge) {
      throw new Error('SemanticVisualizer not initialized — call initialize() first');
    }
    return this.bridge;
  }

  /** Number of live nodes. */
  nodeCount(): number {
    return this.require().nodeCount();
  }

  /** Physically renderable nodes (rooms, zones, sensors, anchors, people…). */
  semanticNodes(): WorldNode[] {
    return this.require().getSemanticNodes();
  }

  /** Every node, including abstract ones. */
  allNodes(): WorldNode[] {
    return this.require().getAllNodes();
  }

  /** Every edge as `[fromId, toId, edge]`. */
  edges(): WorldEdgeTriple[] {
    return this.require().getEdges();
  }

  /** Render-ready primitives for the whole twin (already ENU-mapped). */
  renderPrimitives(): RenderPrimitive[] {
    return this.require().getRenderPrimitives();
  }

  /** Click-to-audit provenance card for a node id (or `null`). */
  provenance(id: number): ProvenanceCard | null {
    return this.require().getProvenance(id);
  }

  /** Build an OccWorld predictive-trajectory overlay. */
  trajectoryOverlay(trackId: number, from: { east_m: number; north_m: number; up_m: number }, steps: TrajectoryStep[]): RenderPrimitive[] {
    return this.require().trajectoryOverlay(trackId, from.east_m, from.north_m, from.up_m, steps);
  }

  /** Upsert a live person track. `id === 0` allocates a fresh node. */
  upsertPerson(id: number, trackId: number, p: { east_m: number; north_m: number; up_m: number }): number {
    return this.require().upsertPerson(id, trackId, p.east_m, p.north_m, p.up_m);
  }

  /** Remove a node (e.g. a person who left). */
  removeNode(id: number): boolean {
    return this.require().removeNode(id);
  }

  /** Author a room from a dragged box gizmo (PlayCanvas centre + size). */
  addRoomFromBox(name: string, areaId: string | null, center: [number, number, number], size: [number, number, number], floor: number): number {
    return this.require().addRoomFromBox(name, areaId, center[0], center[1], center[2], size[0], size[1], size[2], floor);
  }

  /** Author a sensor from a dropped marker at a PlayCanvas position. */
  addSensorFromMarker(deviceId: string, pos: [number, number, number], modality: SensorModality): number {
    return this.require().addSensorFromMarker(deviceId, pos[0], pos[1], pos[2], modality);
  }

  /** Serialize the live twin back to an RVF/JSON payload. */
  exportRvf(): string {
    return this.require().exportRvfJson();
  }
}
