// ADR-202 §1 — reference `SceneBackend` implemented on the PlayCanvas engine.
//
// SuperSplat is a PlayCanvas app, so in production you pass the live `pc`
// namespace and `app` here. We type both against minimal *structural* interfaces
// (`PcNamespace`, `PcApp`) rather than importing `playcanvas` — that keeps this
// package dependency-light and type-checkable in CI without the 10 MB engine,
// while the real `pc` satisfies the shape at the call site.

import type { AssetFormat, RenderPrimitive, RendererCaps, Vec3, Rgba } from './types.js';
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

export interface RuntimeAssetHook {
  (bytes: ArrayBuffer, format: AssetFormat, sourceUrl: string, signal: AbortSignal): Promise<PcEntity>;
}

export interface XrStarter {
  supported: boolean;
  start(mode: 'immersive-vr' | 'immersive-ar'): Promise<void>;
}

export interface AssetLoadPolicy {
  /** Explicit allow-list. Origins are normalized by URL before comparison. */
  allowedOrigins: readonly string[];
  requireIntegrity?: boolean;
  maxBytes?: number;
  timeoutMs?: number;
}

export interface PlayCanvasBackendOptions {
  assetPolicy: AssetLoadPolicy;
  instantiateAsset: RuntimeAssetHook;
  fetch?: typeof globalThis.fetch;
  graphicsDevice?: { isWebGPU?: boolean; deviceType?: string };
  xr?: XrStarter;
}

/** Options to pass when creating PlayCanvas's graphics device. */
export const preferredDeviceOptions = Object.freeze({ deviceTypes: ['webgpu', 'webgl2'] as const });

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
  readonly capabilities: RendererCaps;

  constructor(
    private readonly pc: PcNamespace,
    private readonly app: PcApp,
    private readonly options?: PlayCanvasBackendOptions
  ) {
    const device = options?.graphicsDevice;
    this.capabilities = {
      webgpu: device?.isWebGPU === true || device?.deviceType === 'webgpu',
      xr: options?.xr?.supported === true
    };
  }

  create(prim: RenderPrimitive): EntityHandle {
    const entity = new this.pc.Entity(`${prim.kind}:${prim.id}`);
    const renderType = prim.shape === 'asset' ? (prim.placeholderShape ?? 'box') : prim.shape;
    entity.addComponent('render', { type: renderType, material: this.material(prim) });
    entity.setLocalPosition(prim.position[0], prim.position[1], prim.position[2]);
    entity.setLocalScale(prim.scale[0], prim.scale[1], prim.scale[2]);
    this.app.root.addChild(entity);
    return entity;
  }

  async loadAsset(url: string, format: AssetFormat, integrity: string | undefined, signal: AbortSignal): Promise<EntityHandle> {
    const options = this.options;
    if (!options) throw new Error('runtime asset loading is not configured');
    const parsed = assertAllowedAssetUrl(url, options.assetPolicy);
    if (options.assetPolicy.requireIntegrity === true && !integrity) {
      throw new Error('asset integrity is required by policy');
    }
    const fetcher = options.fetch ?? globalThis.fetch;
    if (!fetcher) throw new Error('fetch is unavailable');

    const timeout = new AbortController();
    const abort = () => timeout.abort();
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => timeout.abort(), options.assetPolicy.timeoutMs ?? 15_000);
    try {
      const response = await fetcher(parsed, { signal: timeout.signal, mode: 'cors', credentials: 'omit' });
      if (!response.ok) throw new Error(`asset request failed (${response.status})`);
      const declared = Number(response.headers.get('content-length'));
      const maxBytes = options.assetPolicy.maxBytes ?? 64 * 1024 * 1024;
      if (Number.isFinite(declared) && declared > maxBytes) throw new Error('asset exceeds configured size limit');
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > maxBytes) throw new Error('asset exceeds configured size limit');
      if (integrity) await verifyIntegrity(bytes, integrity);
      if (timeout.signal.aborted) throw new DOMException('asset load aborted', 'AbortError');
      const entity = await options.instantiateAsset(bytes, format, parsed.href, timeout.signal);
      if (timeout.signal.aborted) {
        entity.destroy();
        throw new DOMException('asset load aborted', 'AbortError');
      }
      this.app.root.addChild(entity);
      return entity;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }
  }

  /** Must be called synchronously from a user gesture when required by WebXR. */
  async startXr(mode: 'immersive-vr' | 'immersive-ar' = 'immersive-vr'): Promise<void> {
    const xr = this.options?.xr;
    if (!xr?.supported) throw new Error('WebXR is not supported');
    await xr.start(mode);
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

export function assertAllowedAssetUrl(url: string, policy: AssetLoadPolicy): URL {
  const parsed = new URL(url, globalThis.location?.href);
  if (parsed.protocol !== 'https:') throw new Error('runtime assets must use HTTPS');
  const allowed = new Set(policy.allowedOrigins.map((origin) => new URL(origin).origin));
  if (!allowed.has(parsed.origin)) throw new Error(`asset origin is not allowed: ${parsed.origin}`);
  return parsed;
}

export async function verifyIntegrity(bytes: ArrayBuffer, integrity: string): Promise<void> {
  const match = /^sha256-([A-Za-z0-9+/]+={0,2})$/.exec(integrity);
  if (!match) throw new Error('only sha256 subresource integrity is supported');
  if (!globalThis.crypto?.subtle) throw new Error('Web Crypto is required for integrity verification');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  const actual = bytesToBase64(new Uint8Array(digest));
  if (actual !== match[1]) throw new Error('asset integrity mismatch');
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const value of bytes) binary += String.fromCharCode(value);
  return globalThis.btoa(binary);
}
