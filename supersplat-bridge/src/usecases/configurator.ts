// ADR-202 §2 — Physical-to-Digital Interactive Graph Editor.
//
// Turns SuperSplat from a splat *editor* into a WorldGraph *configurator*. An
// installer drags 3-D boxes over rooms and drops markers where they mounted
// routers, then clicks Export — and gets a compliant RVF/JSON payload. No
// coordinate grids typed by hand.
//
// All geometry projection (PlayCanvas → ENU) happens in Rust (`core::room_from_box`
// / `sensor_from_marker`); this class just records authored items, forwards them
// to the twin, and serializes. A local preview rectangle (via `pcBoxToEnuRectangle`)
// lets the UI echo ENU bounds before the WASM round-trip.

import type { SensorModality, Vec3 } from '../types.js';
import type { SemanticVisualizer } from '../wasm-bridge.js';
import { pcBoxToEnuRectangle } from '../enu.js';

/** A room authored from a box gizmo. */
export interface AuthoredRoom {
  name: string;
  areaId: string | null;
  /** PlayCanvas gizmo centre. */
  center: Vec3;
  /** PlayCanvas gizmo size (full extents). */
  size: Vec3;
  floor: number;
}

/** A sensor authored from a dropped marker. */
export interface AuthoredSensor {
  deviceId: string;
  /** PlayCanvas marker position. */
  position: Vec3;
  modality: SensorModality;
}

/** A record of what was authored, with the allocated WorldId. */
export interface AuthoredRecord {
  kind: 'room' | 'sensor';
  worldId: number;
  label: string;
}

/**
 * Stateful authoring session over an (initially empty) twin.
 *
 * ```ts
 * const viz = new SemanticVisualizer();
 * await viz.initialize();                 // empty graph
 * const cfg = new Configurator(viz);
 * cfg.addRoom({ name: 'Kitchen', areaId: 'kitchen', center, size, floor: 0 });
 * const rvf = cfg.exportRvf();            // compliant payload
 * ```
 */
export class Configurator {
  private readonly authored: AuthoredRecord[] = [];

  constructor(private readonly viz: SemanticVisualizer) {}

  /** Everything authored so far, in order. */
  get records(): readonly AuthoredRecord[] {
    return this.authored;
  }

  /** Author a room; returns its allocated WorldId. */
  addRoom(room: AuthoredRoom): number {
    const worldId = this.viz.addRoomFromBox(room.name, room.areaId, room.center, room.size, room.floor);
    this.authored.push({ kind: 'room', worldId, label: room.name });
    return worldId;
  }

  /** Author a sensor; returns its allocated WorldId. */
  addSensor(sensor: AuthoredSensor): number {
    const worldId = this.viz.addSensorFromMarker(sensor.deviceId, sensor.position, sensor.modality);
    this.authored.push({ kind: 'sensor', worldId, label: sensor.deviceId });
    return worldId;
  }

  /**
   * Client-side ENU preview of a room box (no WASM round-trip). Lets the UI show
   * "Kitchen: E 1.5–5.5 m, N 0.5–3.5 m" live as the installer drags the gizmo.
   */
  previewRoomBounds(center: Vec3, size: Vec3): ReturnType<typeof pcBoxToEnuRectangle> {
    return pcBoxToEnuRectangle(center, size);
  }

  /** Serialize the authored twin to an RVF/JSON payload for download. */
  exportRvf(): string {
    return this.viz.exportRvf();
  }
}
