/* tslint:disable */
/* eslint-disable */

/**
 * Browser-side handle to a live [`WorldGraph`] digital twin.
 *
 * Constructed from an RVF/JSON payload (or empty, for the visual configurator),
 * it answers render and audit queries each frame and accepts authored / live
 * updates that serialize straight back to a compliant RVF payload.
 */
export class WorldgraphBridge {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Author a room from a dragged 3-D box gizmo (PlayCanvas centre + size).
     */
    addRoomFromBox(name: string, area_id: string | null | undefined, cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, floor: number): bigint;
    /**
     * Author a sensor from a dropped marker at a PlayCanvas position.
     */
    addSensorFromMarker(device_id: string, x: number, y: number, z: number, modality: string): bigint;
    /**
     * Apply a single streamed `{op: ...}` message.
     */
    applyMessageJson(json: string): void;
    /**
     * Start an empty twin registered to the WGS84 origin — the blank canvas the
     * visual configurator authors into (ADR-202 §2).
     */
    static empty(): WorldgraphBridge;
    /**
     * Serialize the live twin back to an RVF/JSON payload (configurator export).
     */
    exportRvfJson(): string;
    /**
     * Every live node, including abstract ones (events, beliefs, rf-links).
     */
    getAllNodes(): any;
    /**
     * Every live edge as `[fromId, toId, edge]` triples.
     */
    getEdges(): any;
    /**
     * The click-to-audit provenance card for a node id, or `null`.
     */
    getProvenance(id: bigint): any;
    /**
     * Render-ready primitives (ENU-mapped, coloured) for the whole twin.
     */
    getRenderPrimitives(): any;
    /**
     * Physically renderable nodes (rooms, zones, sensors, anchors, people…).
     */
    getSemanticNodes(): any;
    /**
     * Load a digital twin from an RVF/JSON payload (the WorldGraph snapshot).
     */
    constructor(rvf_json: string);
    /**
     * Live node count.
     */
    nodeCount(): number;
    /**
     * Remove a node (e.g. a person who has left the building).
     */
    removeNode(id: bigint): boolean;
    /**
     * Build an OccWorld predictive-trajectory overlay from a JS array of
     * `{ point: {east_m,north_m,up_m}, probability }` steps.
     */
    trajectoryOverlay(track_id: bigint, from_e: number, from_n: number, from_u: number, steps: any): any;
    /**
     * Upsert a person track (live RF/ambient update). `id == 0` allocates a
     * fresh node; pass the returned id back on the next frame to move it.
     */
    upsertPerson(id: bigint, track_id: bigint, e: number, n: number, u: number): bigint;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_worldgraphbridge_free: (a: number, b: number) => void;
    readonly worldgraphbridge_addRoomFromBox: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number) => bigint;
    readonly worldgraphbridge_addSensorFromMarker: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [bigint, number, number];
    readonly worldgraphbridge_applyMessageJson: (a: number, b: number, c: number) => [number, number];
    readonly worldgraphbridge_empty: () => number;
    readonly worldgraphbridge_exportRvfJson: (a: number) => [number, number, number, number];
    readonly worldgraphbridge_getAllNodes: (a: number) => [number, number, number];
    readonly worldgraphbridge_getEdges: (a: number) => [number, number, number];
    readonly worldgraphbridge_getProvenance: (a: number, b: bigint) => [number, number, number];
    readonly worldgraphbridge_getRenderPrimitives: (a: number) => [number, number, number];
    readonly worldgraphbridge_getSemanticNodes: (a: number) => [number, number, number];
    readonly worldgraphbridge_new: (a: number, b: number) => [number, number, number];
    readonly worldgraphbridge_nodeCount: (a: number) => number;
    readonly worldgraphbridge_removeNode: (a: number, b: bigint) => number;
    readonly worldgraphbridge_trajectoryOverlay: (a: number, b: bigint, c: number, d: number, e: number, f: any) => [number, number, number];
    readonly worldgraphbridge_upsertPerson: (a: number, b: bigint, c: bigint, d: number, e: number, f: number) => bigint;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
