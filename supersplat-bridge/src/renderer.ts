// ADR-202 §1 — the scene reconciler that draws WorldGraph primitives over the
// splat and keeps them in sync each frame (the zero-video control room).
//
// The reconciler is backend-agnostic: it diffs a list of `RenderPrimitive`s
// against what is currently on screen and issues create / update / destroy calls
// to a `SceneBackend`. This is what makes a person avatar *move* smoothly across
// frames instead of being torn down and rebuilt — and it is fully unit-testable
// with a mock backend (no PlayCanvas, no browser).

import type { AssetFormat, RenderPrimitive, Vec3, Rgba } from './types.js';

/** An opaque per-primitive handle returned by the backend (e.g. a pc.Entity). */
export type EntityHandle = unknown;

/**
 * The minimal scene API the reconciler needs. A PlayCanvas adapter implementing
 * this is ~40 lines (see `playcanvas-adapter.ts`); a mock implementing it powers
 * the tests.
 */
export interface SceneBackend {
  /** Instantiate a solid primitive (box/sphere/cylinder/capsule). */
  create(prim: RenderPrimitive): EntityHandle;
  /** Load and attach a runtime asset. Resolves to its scene entity. */
  loadAsset(url: string, format: AssetFormat, integrity: string | undefined, signal: AbortSignal): Promise<EntityHandle>;
  /** Update an existing entity's position / scale / colour in place. */
  update(handle: EntityHandle, prim: RenderPrimitive): void;
  /** Destroy an entity removed from the twin. */
  destroy(handle: EntityHandle): void;
  /** Immediate-mode line for `line` primitives (redrawn every sync). */
  drawLine(from: Vec3, to: Vec3, color: Rgba): void;
}

/** Stable per-primitive key: a person keeps the same key as it moves. */
export function primitiveKey(p: RenderPrimitive): string {
  return `${p.kind}:${p.id}`;
}

interface Tracked {
  handle: EntityHandle;
  prim: RenderPrimitive;
  load?: { generation: number; controller: AbortController };
}

/**
 * Reconciles WorldGraph render primitives into a live scene.
 *
 * Call {@link sync} every frame (or whenever the twin changes) with the latest
 * `viz.renderPrimitives()`. Solid primitives are created once and updated in
 * place; `line` primitives are immediate-mode and redrawn each call.
 */
export class WorldgraphScene {
  private readonly tracked = new Map<string, Tracked>();
  private generation = 0;

  constructor(private readonly backend: SceneBackend) {}

  /** Number of solid entities currently on screen. */
  get size(): number {
    return this.tracked.size;
  }

  /** Diff `primitives` against the current scene and apply create/update/destroy. */
  sync(primitives: readonly RenderPrimitive[]): void {
    const seen = new Set<string>();

    for (const prim of primitives) {
      if (prim.shape === 'line') {
        // Immediate-mode: drawn fresh every frame, never tracked.
        this.backend.drawLine(prim.position, prim.to, prim.color);
        continue;
      }
      const key = primitiveKey(prim);
      seen.add(key);
      const existing = this.tracked.get(key);
      if (existing) {
        if (!sameIdentity(existing.prim, prim)) {
          this.remove(key, existing);
          this.create(key, prim);
        } else if (!samePlacement(existing.prim, prim)) {
          this.backend.update(existing.handle, prim);
          existing.prim = prim;
        }
      } else {
        this.create(key, prim);
      }
    }

    // Destroy anything no longer present (a person who left, a deleted room).
    for (const [key, t] of this.tracked) {
      if (!seen.has(key)) {
        this.remove(key, t);
      }
    }
  }

  /** Tear down all tracked entities. */
  clear(): void {
    for (const [key, t] of this.tracked) this.remove(key, t);
    this.tracked.clear();
  }

  private create(key: string, prim: RenderPrimitive): void {
    const tracked: Tracked = { handle: this.backend.create(prim), prim };
    this.tracked.set(key, tracked);
    if (prim.shape !== 'asset') return;

    const generation = ++this.generation;
    const controller = new AbortController();
    tracked.load = { generation, controller };
    void this.backend.loadAsset(prim.asset.url, prim.asset.format, prim.asset.integrity, controller.signal)
      .then((loaded) => {
        const current = this.tracked.get(key);
        if (!current || current.load?.generation !== generation || controller.signal.aborted) {
          this.backend.destroy(loaded);
          return;
        }
        this.backend.update(loaded, current.prim);
        this.backend.destroy(current.handle);
        current.handle = loaded;
        delete current.load;
      })
      .catch(() => {
        // A failed or aborted load intentionally leaves the placeholder visible.
      });
  }

  private remove(key: string, tracked: Tracked): void {
    tracked.load?.controller.abort();
    this.backend.destroy(tracked.handle);
    this.tracked.delete(key);
  }
}

function sameIdentity(a: RenderPrimitive, b: RenderPrimitive): boolean {
  if (a.shape !== b.shape) return false;
  if (a.shape !== 'asset' || b.shape !== 'asset') return true;
  return a.asset.url === b.asset.url && a.asset.format === b.asset.format &&
    a.asset.integrity === b.asset.integrity;
}

function samePlacement(a: RenderPrimitive, b: RenderPrimitive): boolean {
  return vec3Eq(a.position, b.position) && vec3Eq(a.scale, b.scale) && rgbaEq(a.color, b.color) &&
    a.transparent === b.transparent;
}

function vec3Eq(a: Vec3, b: Vec3): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

function rgbaEq(a: Rgba, b: Rgba): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}
