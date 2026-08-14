import { enuToPlayCanvas } from '../enu.js';
import type { PresenceUpdate, RenderPrimitive } from '../types.js';
export type { PresenceUpdate } from '../types.js';

/** Maintains pseudonymous viewer markers separately from person tracks. */
export class PresenceLayer {
  private readonly viewers = new Map<number, PresenceUpdate>();

  get size(): number { return this.viewers.size; }

  apply(updates: readonly PresenceUpdate[]): RenderPrimitive[] {
    for (const update of updates) {
      if (update.active) this.viewers.set(update.viewer_id, update);
      else this.viewers.delete(update.viewer_id);
    }
    return this.primitives();
  }

  retainOnly(activeViewerIds: Iterable<number>): number[] {
    const active = new Set(activeViewerIds);
    const removed: number[] = [];
    for (const id of this.viewers.keys()) {
      if (!active.has(id)) { this.viewers.delete(id); removed.push(id); }
    }
    return removed;
  }

  clear(): void { this.viewers.clear(); }

  primitives(): RenderPrimitive[] {
    return [...this.viewers.values()].map((viewer) => ({
      id: viewer.viewer_id,
      kind: 'viewer_presence',
      shape: 'sphere',
      label: `viewer ${viewer.viewer_id}`,
      position: enuToPlayCanvas(viewer.position),
      scale: [0.25, 0.25, 0.25],
      color: [0.2, 0.7, 1, 0.8],
      transparent: true
    }));
  }
}
