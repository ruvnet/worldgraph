import { describe, it, expect } from 'vitest';
import { SemanticVisualizer } from '../src/wasm-bridge.js';
import { PersonTrackLayer } from '../src/usecases/avatars.js';
import { Configurator } from '../src/usecases/configurator.js';
import { TrajectoryOverlay, buildTrajectoryOverlay } from '../src/usecases/occworld.js';
import { ProvenancePanel, worldIdFromKey, formatProvenanceCard, provenanceToMarkdown } from '../src/usecases/audit.js';
import { makeFakeModule } from './fake-bridge.js';

async function viz(seed = [] as Parameters<typeof makeFakeModule>[0]) {
  const v = new SemanticVisualizer();
  await v.initialize({ loader: async () => makeFakeModule(seed) });
  return v;
}

describe('SemanticVisualizer (ADR-200 §2)', () => {
  it('throws before initialize and is ready after', async () => {
    const v = new SemanticVisualizer();
    expect(v.ready).toBe(false);
    expect(() => v.nodeCount()).toThrow(/not initialized/);
    await v.initialize({ loader: async () => makeFakeModule() });
    expect(v.ready).toBe(true);
    expect(v.nodeCount()).toBe(0);
  });
});

describe('PersonTrackLayer — zero-video control room (ADR-202 §1)', () => {
  it('allocates a stable WorldId per track and reuses it on movement', async () => {
    const v = await viz();
    const layer = new PersonTrackLayer(v);
    const first = layer.apply([{ trackId: 7, position: { east_m: 0, north_m: 0, up_m: 0 } }]);
    const wid = first[0]!.worldId;
    expect(wid).toBeGreaterThan(0);
    // Same track moves → same WorldId, no duplicate node.
    const second = layer.apply([{ trackId: 7, position: { east_m: 5, north_m: 0, up_m: 0 } }]);
    expect(second[0]!.worldId).toBe(wid);
    expect(layer.size).toBe(1);
    expect(v.nodeCount()).toBe(1);
  });

  it('removes tracks the sensing layer no longer reports', async () => {
    const v = await viz();
    const layer = new PersonTrackLayer(v);
    layer.apply([
      { trackId: 1, position: { east_m: 0, north_m: 0, up_m: 0 } },
      { trackId: 2, position: { east_m: 1, north_m: 0, up_m: 0 } }
    ]);
    const removed = layer.retainOnly([1]);
    expect(removed).toEqual([2]);
    expect(layer.size).toBe(1);
    expect(v.nodeCount()).toBe(1);
  });
});

describe('Configurator — visual graph editor (ADR-202 §2)', () => {
  it('authors rooms/sensors and exports a compliant RVF payload', async () => {
    const v = await viz();
    const cfg = new Configurator(v);
    const roomId = cfg.addRoom({ name: 'Kitchen', areaId: 'kitchen', center: [3.5, 1.25, -2.0], size: [4, 2.5, 3], floor: 0 });
    cfg.addSensor({ deviceId: 'esp32-a', position: [1, 1.2, -2], modality: 'wifi_csi' });
    expect(roomId).toBeGreaterThan(0);
    expect(cfg.records.map((r) => r.kind)).toEqual(['room', 'sensor']);

    const rvf = JSON.parse(cfg.exportRvf());
    expect(rvf.schema_version).toBe(1);
    const room = rvf.nodes.find((n: { kind: string }) => n.kind === 'room');
    expect(room.bounds_enu).toEqual({ shape: 'rectangle', min_e: 1.5, min_n: 0.5, max_e: 5.5, max_n: 3.5 });
  });

  it('previews ENU bounds client-side before the WASM round-trip', async () => {
    const v = await viz();
    const cfg = new Configurator(v);
    expect(cfg.previewRoomBounds([3.5, 1.25, -2.0], [4, 2.5, 3])).toEqual({ min_e: 1.5, min_n: 0.5, max_e: 5.5, max_n: 3.5 });
  });
});

describe('OccWorld trajectory overlay (ADR-202 §3)', () => {
  it('chains fading line segments from the avatar', () => {
    const prims = buildTrajectoryOverlay(7, { east_m: 0, north_m: 0, up_m: 0 }, [
      { point: { east_m: 1, north_m: 0, up_m: 0 }, probability: 0.9 },
      { point: { east_m: 2, north_m: 0, up_m: 0 }, probability: 0.5 }
    ]);
    expect(prims).toHaveLength(2);
    expect(prims[0]!.position).toEqual([0, 0, 0]);
    expect(prims[0]!.to).toEqual([1, 0, 0]);
    expect(prims[1]!.position).toEqual([1, 0, 0]); // chained
    expect(prims[1]!.color[3]).toBeLessThan(prims[0]!.color[3]); // lower-confidence fades
  });

  it('the bridge path agrees with the pure builder', async () => {
    const v = await viz();
    const overlay = new TrajectoryOverlay(v);
    const steps = [{ point: { east_m: 1, north_m: 1, up_m: 0 }, probability: 0.8 }];
    const from = { east_m: 0, north_m: 0, up_m: 0 };
    expect(overlay.forPrediction(3, from, steps)).toEqual(buildTrajectoryOverlay(3, from, steps));
  });
});

describe('Click-to-audit provenance (ADR-202 §4)', () => {
  it('parses entity keys to WorldIds', () => {
    expect(worldIdFromKey('person_track:42')).toBe(42);
    expect(worldIdFromKey('room:3')).toBe(3);
    expect(worldIdFromKey('garbage')).toBeNull();
  });

  it('resolves a picked person to an anonymous provenance card', async () => {
    const v = await viz();
    const layer = new PersonTrackLayer(v);
    const { worldId } = layer.apply([{ trackId: 5, position: { east_m: 0, north_m: 0, up_m: 0 } }])[0]!;
    const panel = new ProvenancePanel(v);
    const card = panel.onPickEntity(`person_track:${worldId}`)!;
    expect(card.summary).toContain('identity obfuscated');

    const model = formatProvenanceCard(card);
    expect(model.title).toContain('person_track');
    expect(provenanceToMarkdown(card)).toContain('### person_track');
  });

  it('returns null for an unknown pick', async () => {
    const v = await viz();
    const panel = new ProvenancePanel(v);
    expect(panel.onPickEntity('room:999')).toBeNull();
  });
});
