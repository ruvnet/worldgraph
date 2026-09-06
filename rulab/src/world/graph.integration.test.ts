import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RuLabGraph, GRAPH_IDS, type WorldgraphWasmModule } from './graph';
import { TimelineStore } from './timeline';

describe('actual compiled WorldGraph Rust WASM', () => {
  it('stores, replaces, exports and rewinds real graph nodes without growth', async () => {
    const binary = await readFile(resolve('public/wasm/worldgraph_wasm_bg.wasm'));
    const modulePath = pathToFileURL(resolve('public/wasm/worldgraph_wasm.js')).href;
    const wasm = await import(/* @vite-ignore */ modulePath) as WorldgraphWasmModule;
    const graph = new RuLabGraph();
    await graph.initialize(async () => ({ default: () => wasm.default({ module_or_path: binary }), WorldgraphBridge: wasm.WorldgraphBridge }));
    const store = new TimelineStore();
    store.record({ kind: 'door', entityId: 'rf-door', value: true }, 3);
    graph.sync(store.seek(13));
    const reference = graph.exportJson();
    expect(graph.nodeCount()).toBe(14);
    for (let time = 0; time <= 120; time += 1) graph.sync(store.seek(time));
    expect(graph.nodeCount()).toBe(14);
    graph.sync(store.seek(13));
    expect(graph.exportJson()).toBe(reference);
    const snapshot = JSON.parse(reference);
    expect(snapshot.nodes.find((node: { id: number }) => node.id === GRAPH_IDS['rf-door']).center).toEqual({ east_m: 9, north_m: 3, up_m: 0 });
    expect(snapshot.edges).toHaveLength(14);
    store.setScenario('hospitality');
    graph.sync(store.seek(13));
    const switched = JSON.parse(graph.exportJson());
    expect(switched.nodes.find((node: { id: number }) => node.id === 1).area_id).toBe('rulab:hospitality');
    expect(graph.nodeCount()).toBe(14);
    expect(switched.edges).toHaveLength(14);
    graph.dispose();
  });
});
