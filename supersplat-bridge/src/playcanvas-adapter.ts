// ADR-202 §1 — reference `SceneBackend` implemented on the PlayCanvas engine.
//
// SuperSplat is a PlayCanvas app, so in production you pass the live `pc`
// namespace and `app` here. We type both against minimal *structural* interfaces
// (`PcNamespace`, `PcApp`) rather than importing `playcanvas` — that keeps this
// package dependency-light and type-checkable in CI without the 10 MB engine,
// while the real `pc` satisfies the shape at the call site.

import type { RenderPrimitive, Vec3, Rgba } from './types.js';
import type { SceneBackend, EntityHandle } from './renderer.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Subset of `pc.Entity` we touch. */
export interface PcEntity {
  addComponent(type: 'render', opts: { type: string; material: any }): void;
  setLocalPosition(x: number, y: number, z: number): void;
  setLocalScale(x: number, y: number, z: number): void;
  destroy(): void;
}

/** Subset of `pc.Application` we touch. */
export interface PcApp {
  root: { addChild(e: PcEntity): void };
  drawLine(start: any, end: any, color: any): void;
}

/** Subset of the `pc` namespace we touch. */
export interface PcNamespace {
  Entity: new (name?: string) => PcEntity;
  StandardMaterial: new () => any;
  Color: new (r: number, g: number, b: number, a?: number) => any;
  Vec3: new (x: number, y: number, z: number) => any;
  BLEND_NORMAL: number;
}

/** PlayCanvas-backed scene backend for {@link WorldgraphScene}. */
export class PlayCanvasBackend implements SceneBackend {
  constructor(private readonly pc: PcNamespace, private readonly app: PcApp) {}

  create(prim: RenderPrimitive): EntityHandle {
    const entity = new this.pc.Entity(`${prim.kind}:${prim.id}`);
    entity.addComponent('render', { type: prim.shape, material: this.material(prim) });
    entity.setLocalPosition(prim.position[0], prim.position[1], prim.position[2]);
    entity.setLocalScale(prim.scale[0], prim.scale[1], prim.scale[2]);
    this.app.root.addChild(entity);
    return entity;
  }

  update(handle: EntityHandle, prim: RenderPrimitive): void {
    const entity = handle as PcEntity;
    entity.setLocalPosition(prim.position[0], prim.position[1], prim.position[2]);
    entity.setLocalScale(prim.scale[0], prim.scale[1], prim.scale[2]);
  }

  destroy(handle: EntityHandle): void {
    (handle as PcEntity).destroy();
  }

  drawLine(from: Vec3, to: Vec3, color: Rgba): void {
    this.app.drawLine(
      new this.pc.Vec3(from[0], from[1], from[2]),
      new this.pc.Vec3(to[0], to[1], to[2]),
      new this.pc.Color(color[0], color[1], color[2], color[3])
    );
  }

  private material(prim: RenderPrimitive): any {
    const m = new this.pc.StandardMaterial();
    m.diffuse = new this.pc.Color(prim.color[0], prim.color[1], prim.color[2]);
    if (prim.transparent) {
      m.opacity = prim.color[3];
      m.blendType = this.pc.BLEND_NORMAL;
    }
    m.update();
    return m;
  }
}
