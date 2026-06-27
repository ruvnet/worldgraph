import { describe, it, expect } from 'vitest';
import { WorldgraphScene, type SceneBackend, type EntityHandle } from '../src/renderer.js';
import type { RenderPrimitive, Vec3, Rgba } from '../src/types.js';

interface Op {
  op: 'create' | 'update' | 'destroy' | 'line';
  key?: string;
}

class MockBackend implements SceneBackend {
  ops: Op[] = [];
  private seq = 0;
  create(prim: RenderPrimitive): EntityHandle {
    const key = `${prim.kind}:${prim.id}`;
    this.ops.push({ op: 'create', key });
    return { key, handle: this.seq++ };
  }
  update(handle: EntityHandle, prim: RenderPrimitive): void {
    this.ops.push({ op: 'update', key: `${prim.kind}:${prim.id}` });
    void handle;
  }
  destroy(handle: EntityHandle): void {
    this.ops.push({ op: 'destroy', key: (handle as { key: string }).key });
  }
  drawLine(_from: Vec3, _to: Vec3, _color: Rgba): void {
    this.ops.push({ op: 'line' });
  }
}

function sphere(id: number, position: Vec3, kind = 'person_track'): RenderPrimitive {
  return { id, kind, shape: 'sphere', label: 'x', position, scale: [1, 1, 1], color: [1, 1, 1, 1], transparent: false };
}

describe('WorldgraphScene reconciler (ADR-202 §1)', () => {
  it('creates entities on first sync', () => {
    const b = new MockBackend();
    const scene = new WorldgraphScene(b);
    scene.sync([sphere(1, [0, 0, 0]), sphere(2, [1, 0, 0])]);
    expect(scene.size).toBe(2);
    expect(b.ops.filter((o) => o.op === 'create')).toHaveLength(2);
  });

  it('updates a moved person in place (same entity, no destroy)', () => {
    const b = new MockBackend();
    const scene = new WorldgraphScene(b);
    scene.sync([sphere(1, [0, 0, 0])]);
    scene.sync([sphere(1, [5, 0, 0])]); // same key, new position
    expect(b.ops).toEqual([
      { op: 'create', key: 'person_track:1' },
      { op: 'update', key: 'person_track:1' }
    ]);
    expect(scene.size).toBe(1);
  });

  it('does nothing when a primitive is unchanged', () => {
    const b = new MockBackend();
    const scene = new WorldgraphScene(b);
    const p = sphere(1, [0, 0, 0]);
    scene.sync([p]);
    scene.sync([p]);
    expect(b.ops.filter((o) => o.op === 'update')).toHaveLength(0);
  });

  it('destroys entities that disappear (a person who left)', () => {
    const b = new MockBackend();
    const scene = new WorldgraphScene(b);
    scene.sync([sphere(1, [0, 0, 0]), sphere(2, [0, 0, 0])]);
    scene.sync([sphere(1, [0, 0, 0])]); // track 2 gone
    expect(b.ops.at(-1)).toEqual({ op: 'destroy', key: 'person_track:2' });
    expect(scene.size).toBe(1);
  });

  it('draws line primitives immediately every sync without tracking them', () => {
    const b = new MockBackend();
    const scene = new WorldgraphScene(b);
    const line: RenderPrimitive = {
      id: 9,
      kind: 'trajectory',
      shape: 'line',
      label: 'p',
      position: [0, 0, 0],
      scale: [1, 1, 1],
      color: [1, 0, 0, 1],
      to: [1, 0, 0],
      transparent: true
    };
    scene.sync([line]);
    scene.sync([line]);
    expect(b.ops.filter((o) => o.op === 'line')).toHaveLength(2);
    expect(scene.size).toBe(0); // lines are not tracked entities
  });
});
