// ADR-202 §1 — Zero-Video Interactive Control Room.
//
// An external RF/ambient sensing layer (WiFi CSI, mmWave, UWB) reports anonymous
// track positions. This module funnels those into the WASM twin so the scene
// reconciler renders moving avatars — total spatial awareness, zero cameras.
//
// The only state we keep on the JS side is a `trackId → worldId` registry, so a
// repeated report for the same physical person *moves* the existing avatar
// (stable `WorldId`) instead of spawning a duplicate. Pure and testable.

import type { EnuPoint } from '../types.js';
import type { SemanticVisualizer } from '../wasm-bridge.js';

/** A single anonymous track report from the sensing layer. */
export interface TrackUpdate {
  /** Tracker track id (e.g. Kalman id from the pose tracker). */
  trackId: number;
  /** Position in the installation ENU frame. */
  position: EnuPoint;
}

/**
 * Keeps live person tracks in sync with the twin.
 *
 * ```ts
 * const layer = new PersonTrackLayer(viz);
 * layer.apply([{ trackId: 7, position }]);   // each sensing tick
 * scene.sync(viz.renderPrimitives());        // each render frame
 * ```
 */
export class PersonTrackLayer {
  /** trackId → allocated WorldId. */
  private readonly registry = new Map<number, number>();

  constructor(private readonly viz: SemanticVisualizer) {}

  /** Number of live tracks. */
  get size(): number {
    return this.registry.size;
  }

  /** WorldId currently backing a track id, if any. */
  worldIdFor(trackId: number): number | undefined {
    return this.registry.get(trackId);
  }

  /**
   * Apply a batch of track updates, upserting each into the twin. Returns the
   * `trackId → worldId` pairs touched this batch.
   */
  apply(updates: readonly TrackUpdate[]): Array<{ trackId: number; worldId: number }> {
    const touched: Array<{ trackId: number; worldId: number }> = [];
    for (const u of updates) {
      const existing = this.registry.get(u.trackId) ?? 0; // 0 → allocate fresh
      const worldId = this.viz.upsertPerson(existing, u.trackId, u.position);
      this.registry.set(u.trackId, worldId);
      touched.push({ trackId: u.trackId, worldId });
    }
    return touched;
  }

  /**
   * Drop tracks the sensing layer no longer reports (a person left the
   * building). Pass the set of currently-active track ids. Returns removed ids.
   */
  retainOnly(activeTrackIds: Iterable<number>): number[] {
    const active = new Set(activeTrackIds);
    const removed: number[] = [];
    for (const [trackId, worldId] of this.registry) {
      if (!active.has(trackId)) {
        this.viz.removeNode(worldId);
        this.registry.delete(trackId);
        removed.push(trackId);
      }
    }
    return removed;
  }
}
