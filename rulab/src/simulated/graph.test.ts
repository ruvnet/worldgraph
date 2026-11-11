import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RolloutGraph, ROLLOUT_GRAPH_IDS } from './graph';
import { loadRolloutFiles, verifyRollout } from './manifest';
import { CAPTURE_GRAPH_IDS } from '../capture/graph';
import type { RolloutPlaybackState } from './types';
import type { WorldgraphLoader, WorldgraphWasmModule } from '../world/graph';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const SEED = '18446744073709551615';
async function fixture(verify = true) {
  const clip = new Uint8Array(64).fill(7), caption = new TextEncoder().encode('{"prompt":"door opens"}');
  const manifest = {
    format: 'worldgraph.simulated.rollout', version: 1, name: 'RF door opens', simulated: true,
    media: { file: 'clip.mp4', sha256: sha(clip), bytes: clip.length, mediaType: 'video/mp4', width: 1248, height: 704, fps: 24, durationSec: 5 },
    caption: { file: 'caption.json', sha256: sha(caption), bytes: caption.length },
    envelope: { schema_version: 1, session_id: 'pan2-7', epoch: 3, sequence: 9, chunk: {
      frames: [{ transport: 'file', locator: 'clip.mp4', content_hash: `sha256:${sha(clip)}`, byte_length: clip.length, media_type: 'video/mp4' }],
      provenance: { provider: 'pan2', model: 'PAN-2', checkpoint: 'ckpt-a1', runtime_version: '0.3.1', source_snapshot_hash: 'sha256:snapshot-1', source_stream_epoch: 4,
        prompt_action_hash: 'sha256:prompt-1', generation_seed: 0, generation_sequence: 9, simulated: true, confidence: 0.75,
        privacy: { projection_id: 'lab-geometry-v2', hosted_processing_approved: false, redactions_applied: 2, retention: 'ephemeral' },
        license: { license_id: 'Apache-2.0', usage: 'production', redistribution_allowed: true, attribution_required: true, notice: null } } } },
    generation: { hardware: '1x H200 NVL 140GB', steps: 50 },
  };
  // A seed above 2^53 must survive into the Rust graph without rounding.
  const text = JSON.stringify(manifest).replace('"generation_seed":0', `"generation_seed":${SEED}`);
  const bundle = await loadRolloutFiles([new File([text], 'rollout.json'), new File([clip], 'clip.mp4'), new File([caption], 'caption.json')]);
  if (verify) await verifyRollout(bundle);
  return { bundle, mediaSha256: sha(clip), captionSha256: sha(caption) };
}
const loader: WorldgraphLoader = async () => {
  const binary = await readFile(resolve('public/wasm/worldgraph_wasm_bg.wasm'));
  const modulePath = pathToFileURL(resolve('public/wasm/worldgraph_wasm.js')).href;
  const wasm = await import(/* @vite-ignore */ modulePath) as WorldgraphWasmModule;
  return { default: () => wasm.default({ module_or_path: binary }), WorldgraphBridge: wasm.WorldgraphBridge };
};
const state = (phase: RolloutPlaybackState['phase'] = 'ready', positionSec = 0, error: string | null = null): RolloutPlaybackState => ({ phase, positionSec, error });
const statement = (graph: RolloutGraph, id: number) => JSON.parse(JSON.parse(graph.exportJson()).nodes.find((n: any) => n.id === id).statement);

describe('simulated rollout provenance in the actual compiled Rust WASM graph', () => {
  it('stores two zero-confidence semantic nodes and one derived_from edge with model provenance', async () => {
    const { bundle, mediaSha256, captionSha256 } = await fixture(), graph = new RolloutGraph(); await graph.initialize(loader);
    graph.sync(bundle, state());
    const snapshot = JSON.parse(graph.exportJson());
    expect(ROLLOUT_GRAPH_IDS).toEqual({ manifest: 42001, playback: 42002, derivedFrom: 42003 });
    expect(graph.nodeCount()).toBe(2); expect(snapshot.nodes.map((n: any) => n.id).sort()).toEqual([42001, 42002]);
    expect(snapshot.nodes.every((n: any) => n.kind === 'semantic_state' && n.confidence === 0 && n.valid_from_unix_ms === 0)).toBe(true);
    expect(snapshot.edges).toHaveLength(1);
    expect(snapshot.edges[0]).toEqual({ id: 42003, from: 42002, to: 42001, edge: { rel: 'derived_from', evidence: `sha256:${bundle.manifestSha256}` } });
    const required = { simulated: true, provider: 'pan2', model: 'PAN-2', checkpoint: 'ckpt-a1', prompt_action_hash: 'sha256:prompt-1', generation_seed: SEED,
      mediaSha256, source_snapshot_hash: 'sha256:snapshot-1', runtime_version: '0.3.1', source_stream_epoch: '4', generation_sequence: '9',
      classification: 'model-prediction-not-a-capture', manifestSha256: bundle.manifestSha256 };
    const metadata = statement(graph, ROLLOUT_GRAPH_IDS.manifest), position = statement(graph, ROLLOUT_GRAPH_IDS.playback);
    expect(metadata).toMatchObject({ schema: 'worldgraph.simulated.rollout.manifest.v1', ...required, name: 'RF door opens', origin: 'local', captionSha256, firstFrameSha256: null,
      session_id: 'pan2-7', epoch: '3', sequence: '9', providerConfidence: 0.75, generation: { hardware: '1x H200 NVL 140GB', steps: 50 } });
    expect(metadata.privacy).toEqual({ projection_id: 'lab-geometry-v2', hosted_processing_approved: false, redactions_applied: 2, retention: 'ephemeral' });
    expect(metadata.license.license_id).toBe('Apache-2.0'); expect(metadata.media).toMatchObject({ sha256: mediaSha256, bytes: 64, durationSec: 5 });
    expect(metadata.confidenceMeaning).toContain('not assessed'); expect(metadata.validityEpoch).toContain('not-generation-time');
    expect(position).toMatchObject({ schema: 'worldgraph.simulated.rollout.playback.v1', ...required, phase: 'ready', positionSec: 0, error: null, timeBasis: 'clip-relative-seconds-not-world-time' });
    for (const node of snapshot.nodes) {
      expect(node.provenance.evidence).toEqual([`sha256:${bundle.manifestSha256}`, `sha256:${mediaSha256}`]);
      expect(node.provenance.model_version).toBe('pan2/PAN-2@ckpt-a1/runtime-0.3.1');
      expect(node.provenance.privacy_decision).toBe('projection:lab-geometry-v2;retention:ephemeral;hosted:false;redactions:2');
    }
    // Never a capture, an observation, or an authored lab object.
    const exported = graph.exportJson();
    for (const forbidden of ['object_anchor', 'rulab:robotics', 'worldgraph.rulab.capture', 'observed', 'reconstructed', 'declaredSource']) expect(exported).not.toContain(forbidden);
    expect(Object.values(ROLLOUT_GRAPH_IDS).some(id => Object.values(CAPTURE_GRAPH_IDS).includes(id as never))).toBe(false);
    graph.dispose();
  });

  it('replays playback states byte-identically and keeps exactly two nodes and one edge', async () => {
    const { bundle } = await fixture(), graph = new RolloutGraph(); await graph.initialize(loader);
    graph.sync(bundle, state('paused', 1.25)); const original = graph.exportJson();
    for (let i = 0; i < 60; i++) graph.sync(bundle, state(i % 2 ? 'playing' : 'paused', (i % 6) * 0.8));
    graph.sync(bundle, state('ended', 5));
    expect(statement(graph, ROLLOUT_GRAPH_IDS.playback)).toMatchObject({ phase: 'ended', positionSec: 5 });
    graph.sync(bundle, state('error', 2, 'This browser could not decode the verified video.'));
    expect(statement(graph, ROLLOUT_GRAPH_IDS.playback).error).toContain('could not decode');
    graph.sync(bundle, state('paused', 1.25)); expect(graph.exportJson()).toBe(original);
    expect(graph.nodeCount()).toBe(2); expect(JSON.parse(graph.exportJson()).edges).toHaveLength(1);
    graph.dispose();
  });

  it('refuses unverified rollouts and invalid states without changing the Rust graph', async () => {
    const unverified = await fixture(false), graph = new RolloutGraph(); await graph.initialize(loader);
    expect(() => graph.sync(unverified.bundle, state())).toThrow(/must pass SHA-256 verification/);
    expect(graph.nodeCount()).toBe(0);
    const { bundle } = await fixture(); graph.sync(bundle, state()); const original = graph.exportJson();
    const invalid = [
      state('ready', NaN), state('ready', -0.1), state('ready', 5.01), state('playing', Infinity), { ...state(), phase: 'observed' }, { ...state(), phase: 'captured' },
      state('error', 1, null), state('paused', 1, 'unexpected error text'), state('error', 1, 'x'.repeat(513)), { ...state(), error: 4 },
      { ...state(), simulated: false }, { ...state(), source: 'observed' }, { phase: 'ready', positionSec: 0 }, null, [],
      JSON.parse('{"phase":"ready","positionSec":0,"error":null,"__proto__":{"polluted":true}}'),
    ];
    for (const candidate of invalid) { expect(() => graph.sync(bundle, candidate as RolloutPlaybackState), JSON.stringify(candidate)).toThrow(/Invalid rollout playback state/); expect(graph.exportJson()).toBe(original); }
    expect(() => graph.sync({ ...bundle }, state())).toThrow(/validate rollout/); expect(graph.exportJson()).toBe(original);
    expect(graph.ready).toBe(true); graph.dispose();
  });

  it('fails explicitly without WASM, deduplicates initialization and cancels disposal races', async () => {
    const missing = new RolloutGraph(); expect(() => missing.exportJson()).toThrow(/idle/);
    await expect(missing.initialize(async () => { throw new Error('WASM missing'); })).rejects.toThrow('WASM missing');
    expect(missing.status).toBe('unavailable'); expect(missing.ready).toBe(false); expect(() => missing.nodeCount()).toThrow(/unavailable/);
    const graph = new RolloutGraph(); let calls = 0;
    const counted: WorldgraphLoader = async () => { calls++; return loader(); };
    await Promise.all([graph.initialize(counted), graph.initialize(counted)]); expect(calls).toBe(1); expect(graph.ready).toBe(true);
    graph.dispose(); expect(graph.status).toBe('disposed'); await expect(graph.initialize(loader)).rejects.toThrow(/disposed/);
    const cancelled = new RolloutGraph(); let release!: (value: WorldgraphWasmModule) => void;
    const pending = cancelled.initialize(() => new Promise(resolve => { release = resolve; })); cancelled.dispose(); release(await loader());
    await expect(pending).rejects.toThrow(/cancelled/); expect(cancelled.status).toBe('disposed');
  });
});
