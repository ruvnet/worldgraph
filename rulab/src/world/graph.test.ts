import { describe, expect, it, vi } from 'vitest';
import { GRAPH_IDS, REPLAY_EPOCH_UNIX_MS, RuLabGraph, type RustWorldgraphBridge, type WorldgraphWasmModule } from './graph';
import { TimelineStore } from './timeline';

/** Marshaling contract double only. graph.integration.test.ts runs the actual Rust binary. */
function boundaryDouble() {
  const messages: Record<string, any>[] = [];
  const bridge: RustWorldgraphBridge = {
    applyMessageJson: vi.fn((json: string) => { messages.push(JSON.parse(json)); }),
    nodeCount: vi.fn(() => 14),
    exportRvfJson: vi.fn(() => '{"testBoundary":true}'),
    free: vi.fn(),
  };
  const module: WorldgraphWasmModule = { default: vi.fn(async () => undefined), WorldgraphBridge: { empty: vi.fn(() => bridge) } };
  return { messages, bridge, module, loader: vi.fn(async () => module) };
}

describe('Rust WASM graph adapter contract', () => {
  it('never substitutes a JavaScript graph when WASM is absent', async () => {
    const graph = new RuLabGraph();
    expect(() => graph.nodeCount()).toThrow(/idle/);
    await expect(graph.initialize(async () => { throw new Error('WASM missing'); })).rejects.toThrow('WASM missing');
    expect(graph.status).toBe('unavailable');
    expect(graph.error).toBe('WASM missing');
    expect(graph.ready).toBe(false);
    expect(() => graph.exportJson()).toThrow(/unavailable/);
  });

  it('deduplicates concurrent initialization and frees Rust memory on disposal', async () => {
    const boundary = boundaryDouble();
    const graph = new RuLabGraph();
    await Promise.all([graph.initialize(boundary.loader), graph.initialize(boundary.loader)]);
    expect(boundary.loader).toHaveBeenCalledTimes(1);
    expect(boundary.module.default).toHaveBeenCalledTimes(1);
    graph.dispose();
    expect(boundary.bridge.free).toHaveBeenCalledTimes(1);
    expect(graph.status).toBe('disposed');
    await expect(graph.initialize(boundary.loader)).rejects.toThrow(/disposed/);
  });

  it('cancels a pending initialization when disposed', async () => {
    const boundary = boundaryDouble();
    let resolve!: (module: WorldgraphWasmModule) => void;
    const graph = new RuLabGraph();
    const pending = graph.initialize(() => new Promise(done => { resolve = done; }));
    graph.dispose();
    resolve(boundary.module);
    await expect(pending).rejects.toThrow(/cancelled/);
    expect(boundary.module.WorldgraphBridge.empty).not.toHaveBeenCalled();
    expect(graph.status).toBe('disposed');
  });

  it('projects ENU geometry, stable IDs, and explicit authored provenance using supported messages', async () => {
    const boundary = boundaryDouble();
    const graph = new RuLabGraph();
    await graph.initialize(boundary.loader);
    const frame = new TimelineStore().seek(17);
    graph.sync(frame);
    const node = (id: number) => boundary.messages.find(message => message.op === 'upsert_node' && message.node.id === id)!.node;
    expect(node(GRAPH_IDS['robot-1']).position).toEqual({ east_m: 0, north_m: 2, up_m: 0 });
    expect(node(GRAPH_IDS['rf-door']).center).toEqual({ east_m: 9, north_m: 3, up_m: 0 });
    expect(node(GRAPH_IDS['sensor-1']).modality).toBe('uwb');
    expect(node(GRAPH_IDS.room).bounds_enu).toEqual({ shape: 'rectangle', min_e: -12, max_e: 12, min_n: -17, max_n: 17 });
    expect(node(GRAPH_IDS.rfRoom).bounds_enu).toEqual({ shape: 'rectangle', min_e: 7.7, max_e: 12, min_n: -0.2, max_n: 6.2 });
    const provenance = node(GRAPH_IDS['robot-1'] + 100);
    expect(provenance.provenance.calibration_version).toMatch(/not-surveyed/);
    expect(provenance.valid_from_unix_ms).toBe(REPLAY_EPOCH_UNIX_MS + 17_000);
    expect(JSON.parse(provenance.statement).source).toBe('authored');
    expect(JSON.parse(provenance.statement).jointsRadians).toEqual(frame.entities[0]!.joints);
    expect(boundary.messages.filter(message => message.op === 'upsert_node')).toHaveLength(14);
    expect(boundary.messages.filter(message => message.op === 'upsert_edge')).toHaveLength(14);
    expect(graph.nodeCount()).toBe(14);
    expect(graph.exportJson()).toBe('{"testBoundary":true}');
  });

  it('only applies changed messages and keeps edge identities stable', async () => {
    const boundary = boundaryDouble();
    const graph = new RuLabGraph();
    await graph.initialize(boundary.loader);
    const store = new TimelineStore();
    graph.sync(store.seek(10));
    const count = boundary.messages.length;
    graph.sync(store.seek(10));
    expect(boundary.messages).toHaveLength(count);
    graph.sync(store.seek(11));
    expect(boundary.messages.filter(message => message.op === 'upsert_edge')).toHaveLength(14);
    store.setScenario('healthcare');
    graph.sync(store.seek(11));
    const edgeIds = boundary.messages.filter(message => message.op === 'upsert_edge').map(message => message.id);
    expect(new Set(edgeIds).size).toBe(14);
  });

  it('validates all input before any graph mutation', async () => {
    const boundary = boundaryDouble();
    const graph = new RuLabGraph();
    await graph.initialize(boundary.loader);
    for (const invalid of ['provenance', 'coordinate', 'duplicate', 'joint']) {
      const frame = new TimelineStore().getFrame();
      if (invalid === 'provenance') frame.entities[5]!.source = 'observed';
      if (invalid === 'coordinate') frame.entities[5]!.position[0] = NaN;
      if (invalid === 'duplicate') frame.entities[5]!.id = 'sensor-1';
      if (invalid === 'joint') frame.entities[5]!.joints = new Array(100).fill(0);
      expect(() => graph.sync(frame)).toThrow(/entity/);
    }
    expect(boundary.messages).toHaveLength(0);
    expect(graph.ready).toBe(true);
  });

  it('invalidates a partial WASM update explicitly and can reinitialize cleanly', async () => {
    const boundary = boundaryDouble();
    vi.mocked(boundary.bridge.applyMessageJson).mockImplementationOnce(() => { throw new Error('Rust rejected payload'); });
    const graph = new RuLabGraph();
    await graph.initialize(boundary.loader);
    expect(() => graph.sync(new TimelineStore().getFrame())).toThrow(/Rust rejected/);
    expect(graph.status).toBe('unavailable');
    expect(boundary.bridge.free).toHaveBeenCalledTimes(1);
    const recovered = boundaryDouble();
    await graph.initialize(recovered.loader);
    graph.sync(new TimelineStore().getFrame());
    expect(recovered.messages).toHaveLength(28);
  });
});
