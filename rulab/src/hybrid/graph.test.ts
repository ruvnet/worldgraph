import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RustWorldgraphBridge, WorldgraphWasmModule } from '../world/graph';
import { HYBRID_ACTOR_IDS, HYBRID_GRAPH_IDS, HYBRID_MAX_TIME_SECONDS, HybridGraph, type HybridActorState } from './graph';

type Message = { op: string; id?: number; node?: Record<string, any>; from?: number; to?: number; edge?: object };

/** Marshaling/lifecycle double only; this does not claim execution of compiled Rust. */
function boundaryDouble() {
  const messages: Message[] = [];
  const bridge: RustWorldgraphBridge = {
    applyMessageJson: vi.fn((json: string) => { messages.push(JSON.parse(json)); }),
    nodeCount: vi.fn(() => 7), exportRvfJson: vi.fn(() => '{"testBoundary":true}'), free: vi.fn(),
  };
  const module: WorldgraphWasmModule = { default: vi.fn(async () => undefined), WorldgraphBridge: { empty: vi.fn(() => bridge) } };
  return { messages, bridge, module, loader: vi.fn(async () => module) };
}

const actors = (): HybridActorState[] => HYBRID_ACTOR_IDS.map((id, i) => ({ id, position: [i * 4, 0.2, -12 + i], heading: i * 0.2 }));

describe('synthetic coastal Rust graph boundary', () => {
  it('keeps missing WASM explicitly unavailable and allows a clean retry', async () => {
    const graph = new HybridGraph();
    expect(() => graph.nodeCount()).toThrow(/idle/);
    await expect(graph.initialize(async () => { throw new Error('WASM absent'); })).rejects.toThrow('WASM absent');
    expect(graph.status).toBe('unavailable'); expect(graph.error).toBe('WASM absent'); expect(graph.ready).toBe(false);
    expect(() => graph.exportJson()).toThrow(/unavailable/);
    const boundary = boundaryDouble();
    await graph.initialize(boundary.loader);
    expect(graph.ready).toBe(true); expect(graph.error).toBeNull();
  });

  it('deduplicates concurrent initialization and releases a bridge exactly once', async () => {
    const graph = new HybridGraph(); const boundary = boundaryDouble();
    const first = graph.initialize(boundary.loader);
    expect(graph.initialize(boundary.loader)).toBe(first);
    await first;
    await graph.initialize(boundary.loader);
    expect(boundary.loader).toHaveBeenCalledTimes(1);
    graph.dispose(); graph.dispose();
    expect(boundary.bridge.free).toHaveBeenCalledTimes(1); expect(graph.status).toBe('disposed');
    await expect(graph.initialize(boundary.loader)).rejects.toThrow(/disposed/);
  });

  it('cancels disposal during loading without creating a WASM graph', async () => {
    const graph = new HybridGraph(); const boundary = boundaryDouble();
    let resolve!: (module: WorldgraphWasmModule) => void;
    const pending = graph.initialize(() => new Promise(done => { resolve = done; }));
    graph.dispose(); resolve(boundary.module);
    await expect(pending).rejects.toThrow(/cancelled/);
    expect(boundary.module.default).not.toHaveBeenCalled();
    expect(boundary.module.WorldgraphBridge.empty).not.toHaveBeenCalled(); expect(graph.status).toBe('disposed');
  });

  it('cancels disposal during WASM initialization without reviving the adapter', async () => {
    const graph = new HybridGraph(); const boundary = boundaryDouble();
    let finish!: () => void;
    boundary.module.default = vi.fn(() => new Promise<void>(done => { finish = done; }));
    const pending = graph.initialize(boundary.loader);
    await Promise.resolve();
    graph.dispose(); finish();
    await expect(pending).rejects.toThrow(/cancelled/);
    expect(boundary.module.WorldgraphBridge.empty).not.toHaveBeenCalled(); expect(graph.status).toBe('disposed');
  });

  it('rejects an invalid WASM boundary and releases any returned handle', async () => {
    const graph = new HybridGraph(); const boundary = boundaryDouble();
    await expect(graph.initialize(async () => null as unknown as WorldgraphWasmModule)).rejects.toThrow(/Invalid.*module/);
    const badBridge = { free: vi.fn() };
    boundary.module.WorldgraphBridge.empty = () => badBridge as unknown as RustWorldgraphBridge;
    await expect(graph.initialize(boundary.loader)).rejects.toThrow(/Invalid.*bridge/);
    expect(badBridge.free).toHaveBeenCalledTimes(1); expect(graph.ready).toBe(false);
  });

  it('projects seven nodes with zero confidence and explicit synthetic analytic provenance', async () => {
    const graph = new HybridGraph(); const boundary = boundaryDouble();
    await graph.initialize(boundary.loader); graph.sync(17.25, actors());
    const nodes = boundary.messages.filter(message => message.op === 'upsert_node').map(message => message.node!);
    expect(nodes).toHaveLength(7);
    expect(nodes.find(node => node.id === HYBRID_GRAPH_IDS.room)?.area_id).toBeNull();
    const anchor = nodes.find(node => node.id === HYBRID_GRAPH_IDS['coast-walker-1'])!;
    expect(anchor.position).toEqual({ east_m: 0, north_m: 12, up_m: 0.2 }); expect(anchor.confidence).toBe(0);
    const semantics = nodes.filter(node => node.kind === 'semantic_state');
    expect(semantics).toHaveLength(3);
    for (const semantic of semantics) {
      const metadata = JSON.parse(semantic.statement);
      expect(metadata.source).toBe('synthetic'); expect(metadata.simulated).toBe(true); expect(metadata.motion).toBe('analytic');
      expect(metadata.replaySeconds).toBe(17.25); expect(metadata.registration).toMatch(/not-surveyed/);
      expect(metadata.headingBasis).toBe('rotation-about-positive-render-y-axis');
      expect(metadata.anchorMeaning).toMatch(/no RF observation/);
      expect(semantic.confidence).toBe(0); expect(semantic.valid_from_unix_ms).toBe(0);
      expect(semantic.provenance.privacy_decision).toBe('synthetic:no-personal-data');
    }
    expect(JSON.parse(semantics[2]!.statement).headingRadians).toBe(0.4);
    expect(boundary.messages.filter(message => message.op === 'upsert_edge')).toHaveLength(6);
    expect(nodes.some(node => node.kind === 'sensor' || node.kind === 'person_track')).toBe(false);
    expect(graph.nodeCount()).toBe(7); expect(graph.exportJson()).toBe('{"testBoundary":true}');
  });

  it('keeps IDs stable across actor ordering, changing poses and seeking backwards', async () => {
    const graph = new HybridGraph(); const boundary = boundaryDouble(); await graph.initialize(boundary.loader);
    const original = actors(); graph.sync(10, original);
    const initialMessages = boundary.messages.length;
    graph.sync(10, [...original].reverse()); expect(boundary.messages).toHaveLength(initialMessages);
    const changed = actors(); changed[0]!.position[0] += 1;
    graph.sync(20, changed); graph.sync(10, original);
    expect(boundary.messages.filter(message => message.op === 'upsert_edge')).toHaveLength(6);
    expect(new Set(boundary.messages.filter(message => message.op === 'upsert_node').map(message => message.node!.id)).size).toBe(7);
    const lastPose = boundary.messages.filter(message => message.node?.id === HYBRID_GRAPH_IDS['coast-walker-1']).at(-1)!.node!;
    expect(lastPose.position.east_m).toBe(0);
  });

  it.each([NaN, Infinity, -1, HYBRID_MAX_TIME_SECONDS + 1, '1', true])('rejects invalid time %s before graph mutation', async (time) => {
    const graph = new HybridGraph(); const boundary = boundaryDouble(); await graph.initialize(boundary.loader);
    expect(() => graph.sync(time as number, actors())).toThrow(/time/);
    expect(boundary.messages).toHaveLength(0); expect(graph.ready).toBe(true);
  });

  it('validates the complete actor set before applying even the room', async () => {
    const graph = new HybridGraph(); const boundary = boundaryDouble(); await graph.initialize(boundary.loader);
    const mutations: Array<(value: HybridActorState[]) => void> = [
      value => { value.pop(); }, value => { value.push(value[0]!); },
      value => { value[2]!.id = 'unknown'; }, value => { value[2]!.id = value[0]!.id; },
      value => { value[2]!.position[0] = NaN; }, value => { value[2]!.position[0] = 201; },
      value => { value[2]!.position[1] = -0.1; }, value => { value[2]!.position[2] = Infinity; },
      value => { value[2]!.position[2] = -181; }, value => { value[2]!.heading = 3 * Math.PI; },
      value => { value[2]!.heading = true as unknown as number; },
      value => { value[2]!.position = [0, 0] as unknown as [number, number, number]; },
      value => { value[2] = null as unknown as HybridActorState; },
    ];
    for (const mutate of mutations) { const value = actors(); mutate(value); expect(() => graph.sync(0, value)).toThrow(); }
    expect(boundary.messages).toHaveLength(0); expect(graph.ready).toBe(true);
  });

  it('invalidates and frees a partially updated Rust graph before allowing recovery', async () => {
    const graph = new HybridGraph(); const boundary = boundaryDouble(); await graph.initialize(boundary.loader);
    vi.mocked(boundary.bridge.applyMessageJson)
      .mockImplementationOnce(json => { boundary.messages.push(JSON.parse(json)); })
      .mockImplementationOnce(() => { throw new Error('Rust rejected update'); });
    expect(() => graph.sync(0, actors())).toThrow(/Rust rejected update/);
    expect(graph.status).toBe('unavailable'); expect(boundary.bridge.free).toHaveBeenCalledTimes(1);
    expect(() => graph.exportJson()).toThrow(/unavailable/);
    const recovered = boundaryDouble(); await graph.initialize(recovered.loader); graph.sync(0, actors());
    expect(recovered.messages).toHaveLength(13);
  });

  it('preserves a disposed state when WASM release itself throws', async () => {
    const graph = new HybridGraph(); const boundary = boundaryDouble(); await graph.initialize(boundary.loader);
    vi.mocked(boundary.bridge.free!).mockImplementation(() => { throw new Error('release failure'); });
    graph.dispose(); expect(graph.status).toBe('disposed'); expect(graph.ready).toBe(false);
    expect(graph.error).toMatch(/release failure/); expect(() => graph.nodeCount()).toThrow(/disposed/);
  });
});

describe('actual compiled coastal WorldGraph Rust WASM', () => {
  it('stores seven synthetic nodes, preserves isolation and restores the same serialized state after rewind', async () => {
    const binary = await readFile(resolve('public/wasm/worldgraph_wasm_bg.wasm'));
    const modulePath = pathToFileURL(resolve('public/wasm/worldgraph_wasm.js')).href;
    const wasm = await import(/* @vite-ignore */ modulePath) as WorldgraphWasmModule;
    const graph = new HybridGraph();
    await graph.initialize(async () => ({ default: () => wasm.default({ module_or_path: binary }), WorldgraphBridge: wasm.WorldgraphBridge }));
    const otherGraph = wasm.WorldgraphBridge.empty();
    const otherBefore = otherGraph.exportRvfJson();
    try {
      const referenceActors = actors();
      graph.sync(17.25, referenceActors);
      const reference = graph.exportJson();
      const snapshot = JSON.parse(reference);
      expect(graph.nodeCount()).toBe(7); expect(snapshot.nodes).toHaveLength(7); expect(snapshot.edges).toHaveLength(6);
      expect(snapshot.nodes.find((node: { id: number }) => node.id === HYBRID_GRAPH_IDS.room).area_id).toBeNull();
      const anchor = snapshot.nodes.find((node: { id: number }) => node.id === HYBRID_GRAPH_IDS['coast-walker-1']);
      expect(anchor.position.east_m).toBe(0); expect(anchor.position.north_m).toBe(12); expect(anchor.position.up_m).toBeCloseTo(.2);
      for (const node of snapshot.nodes) {
        if (node.kind === 'room') continue;
        expect(node.confidence).toBe(0);
        if (node.kind === 'semantic_state') {
          const metadata = JSON.parse(node.statement);
          expect(metadata.source).toBe('synthetic'); expect(metadata.motion).toBe('analytic');
          expect(metadata.replaySeconds).toBe(17.25); expect(node.valid_from_unix_ms).toBe(0);
          expect(metadata.registration).toMatch(/not-surveyed/);
        }
      }
      for (let time = 0; time <= 120; time++) {
        const moving = actors();
        for (const [index, actor] of moving.entries()) actor.position[0] += Math.sin(time / 10 + index) * 20;
        graph.sync(time, moving);
      }
      expect(graph.nodeCount()).toBe(7);
      expect(JSON.parse(graph.exportJson()).edges).toHaveLength(6);
      expect(graph.exportJson()).not.toBe(reference);
      graph.sync(17.25, [...referenceActors].reverse());
      expect(graph.exportJson()).toBe(reference);
      expect(otherGraph.nodeCount()).toBe(0); expect(otherGraph.exportRvfJson()).toBe(otherBefore);
    } finally {
      graph.dispose(); otherGraph.free?.();
    }
    expect(graph.status).toBe('disposed');
  });
});
