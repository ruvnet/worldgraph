import { loadWorldgraphWasm, type GraphStatus, type RustWorldgraphBridge, type WorldgraphLoader } from '../world/graph';
import { assertRolloutBundle, verifiedRollout } from './manifest';
import type { RolloutBundle, RolloutPlaybackState } from './types';

/** Disjoint from authored ids (1–206) and capture ids (41001–41003). */
export const ROLLOUT_GRAPH_IDS = Object.freeze({ manifest: 42001, playback: 42002, derivedFrom: 42003 });
/** Required Rust validity field only. Zero is not asserted to be a generation or world timestamp. */
export const ROLLOUT_VALIDITY_EPOCH_UNIX_MS = 0;
const PHASES = ['ready', 'playing', 'paused', 'ended', 'error'];

function playback(bundle: RolloutBundle, state: RolloutPlaybackState) {
  if (!state || typeof state !== 'object' || Array.isArray(state) || Object.getPrototypeOf(state) !== Object.prototype ||
    Object.keys(state).length !== 3 || Object.keys(state).some(key => !['phase', 'positionSec', 'error'].includes(key)) ||
    !PHASES.includes(state.phase) ||
    typeof state.positionSec !== 'number' || !Number.isFinite(state.positionSec) || state.positionSec < 0 || state.positionSec > bundle.manifest.media.durationSec ||
    (state.error !== null && (typeof state.error !== 'string' || state.error.length > 512)) ||
    (state.phase === 'error') !== (state.error !== null)) throw new TypeError('Invalid rollout playback state.');
  return { phase: state.phase, positionSec: state.positionSec, error: state.error };
}

/**
 * ADR-204 §1: a model-derived claim enters WorldGraph only as a SemanticState with explicit
 * provenance. This is a separate Rust graph instance holding two semantic nodes and one edge.
 * It never touches the authored graph or the capture graph, and holds no frame pixels.
 */
export class RolloutGraph {
  private bridge: RustWorldgraphBridge | null = null;
  private pending: Promise<void> | null = null;
  private generation = 0;
  private applied = new Map<number, string>();
  status: GraphStatus = 'idle';
  error: string | null = null;

  get ready(): boolean { return this.status === 'ready' && this.bridge !== null; }

  initialize(loader: WorldgraphLoader = loadWorldgraphWasm): Promise<void> {
    if (this.status === 'disposed') return Promise.reject(new Error('Rollout graph has been disposed.'));
    if (this.ready) return Promise.resolve();
    if (this.pending) return this.pending;
    this.status = 'loading'; this.error = null;
    const generation = ++this.generation;
    const pending = (async () => {
      const module = await loader();
      if (typeof module.default !== 'function' || typeof module.WorldgraphBridge?.empty !== 'function') throw new Error('Invalid WorldGraph WASM module.');
      await module.default();
      if (generation !== this.generation) throw new Error('Rollout graph initialization was cancelled.');
      this.bridge = module.WorldgraphBridge.empty(); this.status = 'ready';
    })().catch((error: unknown) => {
      if (generation === this.generation) { this.status = 'unavailable'; this.error = error instanceof Error ? error.message : String(error); this.bridge = null; }
      throw error;
    }).finally(() => { if (this.pending === pending) this.pending = null; });
    this.pending = pending;
    return pending;
  }

  private require(): RustWorldgraphBridge {
    if (!this.ready || !this.bridge) throw new Error(`Rollout graph WASM is ${this.status}; initialize it before use.`);
    return this.bridge;
  }

  /** Record the opened rollout. Refuses any rollout whose media has not passed SHA-256 verification. */
  sync(bundle: RolloutBundle, state: RolloutPlaybackState): void {
    const bridge = this.require();
    assertRolloutBundle(bundle);
    const checked = verifiedRollout(bundle);
    if (!checked) throw new Error('A rollout must pass SHA-256 verification before it is recorded in the graph.');
    const position = playback(bundle, state);
    const { manifest } = bundle, { envelope } = manifest, source = envelope.chunk.provenance;
    const manifestEvidence = `sha256:${bundle.manifestSha256}`, mediaEvidence = `sha256:${checked.mediaSha256}`;
    const common = {
      simulated: true, classification: 'model-prediction-not-a-capture', manifestSha256: bundle.manifestSha256,
      provider: source.provider, model: source.model, checkpoint: source.checkpoint, runtime_version: source.runtime_version,
      source_snapshot_hash: source.source_snapshot_hash, source_stream_epoch: source.source_stream_epoch,
      prompt_action_hash: source.prompt_action_hash, generation_seed: source.generation_seed, generation_sequence: source.generation_sequence,
      mediaSha256: checked.mediaSha256,
      integers: 'unsigned 64-bit values are exact decimal strings',
      validityEpoch: 'schema-placeholder-unix-zero-not-generation-time',
      confidenceMeaning: 'node confidence is zero: predictive accuracy not assessed; providerConfidence is the provider-reported value, unverified',
    };
    const node = (id: number, statement: object) => ({ kind: 'semantic_state', id, statement: JSON.stringify(statement), confidence: 0,
      provenance: { evidence: [manifestEvidence, mediaEvidence], model_version: `${source.provider}/${source.model}@${source.checkpoint}/runtime-${source.runtime_version}`,
        calibration_version: 'simulated-output-no-sensor-calibration',
        privacy_decision: `projection:${source.privacy.projection_id};retention:${source.privacy.retention};hosted:${source.privacy.hosted_processing_approved};redactions:${source.privacy.redactions_applied}` },
      valid_from_unix_ms: ROLLOUT_VALIDITY_EPOCH_UNIX_MS });
    const nodes = [
      node(ROLLOUT_GRAPH_IDS.manifest, { schema: 'worldgraph.simulated.rollout.manifest.v1', ...common, name: manifest.name, origin: bundle.origin,
        media: manifest.media, captionSha256: checked.captionSha256, firstFrameSha256: checked.firstFrameSha256,
        session_id: envelope.session_id, epoch: envelope.epoch, sequence: envelope.sequence, providerConfidence: source.confidence,
        privacy: source.privacy, license: source.license, generation: manifest.generation ?? null }),
      node(ROLLOUT_GRAPH_IDS.playback, { schema: 'worldgraph.simulated.rollout.playback.v1', ...common, timeBasis: 'clip-relative-seconds-not-world-time', ...position }),
    ];
    const updates = nodes.map(value => ({ id: value.id, json: JSON.stringify({ op: 'upsert_node', node: value }) }));
    updates.push({ id: ROLLOUT_GRAPH_IDS.derivedFrom, json: JSON.stringify({ op: 'upsert_edge', id: ROLLOUT_GRAPH_IDS.derivedFrom,
      from: ROLLOUT_GRAPH_IDS.playback, to: ROLLOUT_GRAPH_IDS.manifest, edge: { rel: 'derived_from', evidence: manifestEvidence } }) });
    try {
      for (const { id, json } of updates) { if (this.applied.get(id) === json) continue; bridge.applyMessageJson(json); this.applied.set(id, json); }
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error); this.status = 'unavailable'; this.bridge = null; this.applied.clear(); bridge.free?.();
      throw new Error(`Rollout graph WASM update failed: ${this.error}`, { cause: error });
    }
  }

  exportJson(): string { return this.require().exportRvfJson(); }
  nodeCount(): number { return this.require().nodeCount(); }
  dispose(): void { ++this.generation; this.bridge?.free?.(); this.bridge = null; this.applied.clear(); this.status = 'disposed'; }
}
