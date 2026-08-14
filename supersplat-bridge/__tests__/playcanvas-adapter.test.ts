import { describe, expect, it, vi } from 'vitest';
import { PlayCanvasBackend, assertAllowedAssetUrl, preferredDeviceOptions, type PcApp, type PcNamespace } from '../src/playcanvas-adapter.js';

describe('PlayCanvas adapter policy', () => {
  it('prefers WebGPU while retaining WebGL2 fallback', () => {
    expect(preferredDeviceOptions.deviceTypes).toEqual(['webgpu', 'webgl2']);
  });

  it('allows only explicitly configured HTTPS asset origins', () => {
    const policy = { allowedOrigins: ['https://assets.example'] };
    expect(assertAllowedAssetUrl('https://assets.example/chair.glb', policy).pathname).toBe('/chair.glb');
    expect(() => assertAllowedAssetUrl('http://assets.example/chair.glb', policy)).toThrow(/HTTPS/);
    expect(() => assertAllowedAssetUrl('https://evil.example/chair.glb', policy)).toThrow(/not allowed/);
  });

  it('exposes WebGPU/XR capabilities and delegates XR start', async () => {
    const start = vi.fn(async () => undefined);
    const backend = new PlayCanvasBackend({} as PcNamespace, {} as PcApp, {
      assetPolicy: { allowedOrigins: [] },
      instantiateAsset: async () => { throw new Error('unused'); },
      graphicsDevice: { deviceType: 'webgpu' },
      xr: { supported: true, start }
    });
    expect(backend.capabilities).toEqual({ webgpu: true, xr: true });
    await backend.startXr('immersive-ar');
    expect(start).toHaveBeenCalledWith('immersive-ar');
  });
});
