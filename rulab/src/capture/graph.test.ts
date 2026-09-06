import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CaptureGraph, CAPTURE_GRAPH_IDS } from './graph';
import { loadCaptureFiles, loadCaptureFrame } from './manifest';
import type { CapturePlaybackState } from './types';
import type { WorldgraphLoader, WorldgraphWasmModule } from '../world/graph';

async function fixture() {
  const bytes = new Uint8Array(32); new DataView(bytes.buffer).setFloat32(12, .2, true); bytes.set([200, 120, 90, 255, 255, 128, 128, 128], 24);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const manifest = { format: 'worldgraph.rulab.capture', version: 1, name: 'Declared observed capture', source: 'observed', coordinateSystem: 'right-handed-y-up', units: 'metres', duration: 3,
    bounds: { min: [-1, 0, -1], max: [1, 2, 1] }, frames: [0, 1, 2].map(time => ({ time, file: `${time}.splat`, sha256 })) };
  return await loadCaptureFiles([new File([JSON.stringify(manifest)], 'capture.json'), ...manifest.frames.map(frame => new File([bytes], frame.file))]);
}
const loader: WorldgraphLoader = async () => {
  const binary = await readFile(resolve('public/wasm/worldgraph_wasm_bg.wasm'));
  const modulePath = pathToFileURL(resolve('public/wasm/worldgraph_wasm.js')).href;
  const wasm = await import(/* @vite-ignore */ modulePath) as WorldgraphWasmModule;
  return { default: () => wasm.default({ module_or_path: binary }), WorldgraphBridge: wasm.WorldgraphBridge };
};
const state = (index: number | null, requestedTime = index ?? 0, loading = false, error: string | null = null): CapturePlaybackState => ({ requestedTime, displayedIndex: index, displayedTime: index, loading, error });

describe('capture provenance in the actual compiled Rust WASM graph', () => {
  it('stores two semantic nodes and one edge with verified display provenance, without lab objects', async () => {
    const bundle = await fixture(), graph = new CaptureGraph(); await graph.initialize(loader);
    graph.sync(bundle, state(null, 1, true));
    let snapshot = JSON.parse(graph.exportJson());
    expect(graph.nodeCount()).toBe(2); expect(snapshot.edges).toHaveLength(1);
    const pending = JSON.parse(snapshot.nodes.find((n: any) => n.id === CAPTURE_GRAPH_IDS.playback).statement);
    expect(pending).toMatchObject({ requestedTime: 1, displayedIndex: null, displayedTime: null, loading: true, displayedFileSha256: null });
    await loadCaptureFrame(bundle, 0); graph.sync(bundle, state(0, 1, true));
    snapshot = JSON.parse(graph.exportJson());
    expect(snapshot.nodes.map((n: any) => n.id).sort()).toEqual([41001, 41002]);
    expect(snapshot.nodes.every((n: any) => n.kind === 'semantic_state' && n.valid_from_unix_ms === 0 && n.confidence === 0)).toBe(true);
    const metadata = JSON.parse(snapshot.nodes.find((n: any) => n.id === CAPTURE_GRAPH_IDS.manifest).statement);
    const displayedNode = snapshot.nodes.find((n: any) => n.id === CAPTURE_GRAPH_IDS.playback);
    const displayed = JSON.parse(displayedNode.statement);
    expect(metadata).toMatchObject({ manifestSha256: bundle.manifestSha256, declaredSource: 'observed', registration: 'unverified', timeBasis: 'capture-relative-seconds' });
    expect(metadata.normalization).toContain('not metric alignment'); expect(metadata.validityEpoch).toContain('not-capture-time');
    expect(displayed).toMatchObject({ requestedTime: 1, displayedIndex: 0, displayedTime: 0, loading: true, displayedFile: '0.splat', displayedFileSha256: bundle.manifest.frames[0].sha256 });
    expect(displayedNode.provenance.evidence).toContain(`sha256:${bundle.manifest.frames[0].sha256}`);
    expect(graph.exportJson()).not.toContain('object_anchor'); expect(graph.exportJson()).not.toContain('rulab:robotics');
    graph.dispose();
  });

  it('replays reverse seeks byte-identically and preserves a prior displayed sample while loading or failed', async () => {
    const bundle = await fixture(), graph = new CaptureGraph(); await graph.initialize(loader);
    for (let i = 0; i < 3; i++) await loadCaptureFrame(bundle, i);
    const originalState = state(1, 1.25); graph.sync(bundle, originalState); const original = graph.exportJson();
    for (let i = 0; i < 90; i++) graph.sync(bundle, state(i % 3, Math.min(3, i % 3 + .75)));
    graph.sync(bundle, state(2, .5, true));
    let displayed = JSON.parse(JSON.parse(graph.exportJson()).nodes.find((n: any) => n.id === CAPTURE_GRAPH_IDS.playback).statement);
    expect(displayed).toMatchObject({ requestedTime: .5, displayedIndex: 2, displayedTime: 2, loading: true });
    graph.sync(bundle, state(2, .5, false, 'SHA-256 mismatch for requested frame.'));
    displayed = JSON.parse(JSON.parse(graph.exportJson()).nodes.find((n: any) => n.id === CAPTURE_GRAPH_IDS.playback).statement);
    expect(displayed.error).toContain('SHA-256 mismatch'); expect(displayed.displayedIndex).toBe(2);
    graph.sync(bundle, originalState); expect(graph.exportJson()).toBe(original);
    expect(graph.nodeCount()).toBe(2); expect(JSON.parse(graph.exportJson()).edges).toHaveLength(1);
    graph.dispose();
  });

  it('rejects unverified, forged or inconsistent states before changing the Rust graph', async () => {
    const bundle = await fixture(), graph = new CaptureGraph(); await graph.initialize(loader); graph.sync(bundle, state(null));
    const original = graph.exportJson();
    expect(() => graph.sync(bundle, state(0))).toThrow(/verification/);
    expect(graph.exportJson()).toBe(original);
    await loadCaptureFrame(bundle, 0);
    const invalid = [
      { ...state(0), requestedTime: NaN }, { ...state(0), requestedTime: 3.01 }, { ...state(0), requestedTime: -1 },
      { ...state(0), displayedIndex: 3 }, { ...state(0), displayedIndex: .5 }, { ...state(0), displayedTime: 1 },
      { ...state(null), displayedTime: 0 }, { ...state(0), loading: 'yes' }, { ...state(0), error: 'x'.repeat(513) },
      { ...state(0), source: 'observed' }, JSON.parse('{"requestedTime":0,"displayedIndex":null,"displayedTime":null,"loading":false,"error":null,"__proto__":{"polluted":true}}'),
    ];
    for (const candidate of invalid) { expect(() => graph.sync(bundle, candidate as CapturePlaybackState)).toThrow(); expect(graph.exportJson()).toBe(original); }
    expect(() => graph.sync({ ...bundle }, state(null))).toThrow(/validate capture/); expect(graph.exportJson()).toBe(original);
    expect(graph.ready).toBe(true); graph.dispose();
  });

  it('fails explicitly without WASM, deduplicates initialization and cancels disposal races', async () => {
    const missing = new CaptureGraph(); expect(() => missing.exportJson()).toThrow(/idle/);
    await expect(missing.initialize(async () => { throw new Error('WASM missing'); })).rejects.toThrow('WASM missing');
    expect(missing.status).toBe('unavailable'); expect(missing.ready).toBe(false); expect(() => missing.nodeCount()).toThrow(/unavailable/);
    const graph = new CaptureGraph(); let calls = 0;
    const counted: WorldgraphLoader = async () => { calls++; return loader(); };
    await Promise.all([graph.initialize(counted), graph.initialize(counted)]); expect(calls).toBe(1); expect(graph.ready).toBe(true);
    graph.dispose(); expect(graph.status).toBe('disposed'); await expect(graph.initialize(loader)).rejects.toThrow(/disposed/);
    const cancelled = new CaptureGraph(); let release!: (value: WorldgraphWasmModule) => void;
    const pending = cancelled.initialize(() => new Promise(resolve => { release = resolve; })); cancelled.dispose(); release(await loader());
    await expect(pending).rejects.toThrow(/cancelled/); expect(cancelled.status).toBe('disposed');
  });
});
