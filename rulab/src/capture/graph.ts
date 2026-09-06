import { loadWorldgraphWasm, type GraphStatus, type RustWorldgraphBridge, type WorldgraphLoader } from '../world/graph';
import { assertCaptureBundle, verifiedCaptureFrameSha256 } from './manifest';
import type { CaptureBundle, CapturePlaybackState } from './types';

export const CAPTURE_GRAPH_IDS = Object.freeze({ manifest: 41001, playback: 41002, derivedFrom: 41003 });
/** Required Rust validity field only. Zero is not asserted to be a capture timestamp. */
export const CAPTURE_VALIDITY_EPOCH_UNIX_MS = 0;

function playback(bundle: CaptureBundle, state: CapturePlaybackState) {
  if (!state || typeof state !== 'object' || Array.isArray(state) || Object.getPrototypeOf(state) !== Object.prototype ||
    Object.keys(state).length !== 5 || Object.keys(state).some(key => !['requestedTime', 'displayedIndex', 'displayedTime', 'loading', 'error'].includes(key)) ||
    typeof state.requestedTime !== 'number' || !Number.isFinite(state.requestedTime) || state.requestedTime < 0 || state.requestedTime > bundle.manifest.duration ||
    typeof state.loading !== 'boolean' || (state.error !== null && (typeof state.error !== 'string' || state.error.length > 512))) throw new TypeError('Invalid capture playback state.');
  let displayedFileSha256: string | null = null, displayedFile: string | null = null;
  if (state.displayedIndex === null) {
    if (state.displayedTime !== null) throw new TypeError('A capture without a displayed sample must have null displayed time.');
  } else {
    if (!Number.isSafeInteger(state.displayedIndex) || state.displayedIndex < 0 || state.displayedIndex >= bundle.manifest.frames.length) throw new RangeError('Displayed capture index is out of bounds.');
    const frame = bundle.manifest.frames[state.displayedIndex];
    if (state.displayedTime !== frame.time) throw new TypeError('Displayed capture time does not match its sample.');
    displayedFileSha256 = verifiedCaptureFrameSha256(bundle, state.displayedIndex);
    if (!displayedFileSha256) throw new Error('A displayed capture sample must pass SHA-256 verification and preflight first.');
    displayedFile = frame.file;
  }
  return { requestedTime: state.requestedTime, displayedIndex: state.displayedIndex, displayedTime: state.displayedTime,
    loading: state.loading, error: state.error, displayedFile, displayedFileSha256 };
}

/** Two native Rust semantic nodes for capture metadata and display state; no authored lab projection. */
export class CaptureGraph {
  private bridge: RustWorldgraphBridge | null = null;
  private pending: Promise<void> | null = null;
  private generation = 0;
  private applied = new Map<number, string>();
  status: GraphStatus = 'idle';
  error: string | null = null;

  get ready(): boolean { return this.status === 'ready' && this.bridge !== null; }

  initialize(loader: WorldgraphLoader = loadWorldgraphWasm): Promise<void> {
    if (this.status === 'disposed') return Promise.reject(new Error('Capture graph has been disposed.'));
    if (this.ready) return Promise.resolve();
    if (this.pending) return this.pending;
    this.status = 'loading'; this.error = null;
    const generation = ++this.generation;
    const pending = (async () => {
      const module = await loader();
      if (typeof module.default !== 'function' || typeof module.WorldgraphBridge?.empty !== 'function') throw new Error('Invalid WorldGraph WASM module.');
      await module.default();
      if (generation !== this.generation) throw new Error('Capture graph initialization was cancelled.');
      this.bridge = module.WorldgraphBridge.empty(); this.status = 'ready';
    })().catch((error: unknown) => {
      if (generation === this.generation) { this.status = 'unavailable'; this.error = error instanceof Error ? error.message : String(error); this.bridge = null; }
      throw error;
    }).finally(() => { if (this.pending === pending) this.pending = null; });
    this.pending = pending;
    return pending;
  }

  private require(): RustWorldgraphBridge {
    if (!this.ready || !this.bridge) throw new Error(`Capture graph WASM is ${this.status}; initialize it before use.`);
    return this.bridge;
  }

  sync(bundle: CaptureBundle, state: CapturePlaybackState): void {
    const bridge = this.require();
    assertCaptureBundle(bundle);
    const displayed = playback(bundle, state);
    const manifestEvidence = `sha256:${bundle.manifestSha256}`;
    const common = { manifestSha256: bundle.manifestSha256, declaredSource: bundle.manifest.source,
      registration: 'unverified', timeBasis: 'capture-relative-seconds', validityEpoch: 'schema-placeholder-unix-zero-not-capture-time',
      normalization: 'display normalization only; not metric alignment', confidenceMeaning: 'spatial and reconstruction accuracy not assessed' };
    const node = (id: number, statement: object, evidence: string[]) => ({ kind: 'semantic_state', id, statement: JSON.stringify(statement),
      confidence: 0, provenance: { evidence, model_version: 'capture-playback-v1-no-learned-model',
        calibration_version: 'unverified-no-metric-registration', privacy_decision: 'local-user-provided-content-not-assessed' },
      valid_from_unix_ms: CAPTURE_VALIDITY_EPOCH_UNIX_MS });
    const nodes = [
      node(CAPTURE_GRAPH_IDS.manifest, { schema: 'worldgraph.rulab.capture.manifest.v1', ...common, manifest: bundle.manifest }, [manifestEvidence]),
      node(CAPTURE_GRAPH_IDS.playback, { schema: 'worldgraph.rulab.capture.playback.v1', ...common, ...displayed },
        displayed.displayedFileSha256 ? [manifestEvidence, `sha256:${displayed.displayedFileSha256}`] : [manifestEvidence]),
    ];
    const updates = nodes.map(value => ({ id: value.id, json: JSON.stringify({ op: 'upsert_node', node: value }) }));
    updates.push({ id: CAPTURE_GRAPH_IDS.derivedFrom, json: JSON.stringify({ op: 'upsert_edge', id: CAPTURE_GRAPH_IDS.derivedFrom,
      from: CAPTURE_GRAPH_IDS.playback, to: CAPTURE_GRAPH_IDS.manifest, edge: { rel: 'derived_from', evidence: manifestEvidence } }) });
    try {
      for (const { id, json } of updates) { if (this.applied.get(id) === json) continue; bridge.applyMessageJson(json); this.applied.set(id, json); }
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error); this.status = 'unavailable'; this.bridge = null; this.applied.clear(); bridge.free?.();
      throw new Error(`Capture graph WASM update failed: ${this.error}`, { cause: error });
    }
  }

  exportJson(): string { return this.require().exportRvfJson(); }
  nodeCount(): number { return this.require().nodeCount(); }
  dispose(): void { ++this.generation; this.bridge?.free?.(); this.bridge = null; this.applied.clear(); this.status = 'disposed'; }
}
