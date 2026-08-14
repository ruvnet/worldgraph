import { describe, expect, it } from 'vitest';
import { assertBootstrap, websocketUrl } from './bootstrap.js';

describe('demo bootstrap', () => {
  it('resolves a relative socket against the page and changes protocol', () => {
    expect(websocketUrl('/v1/twin/ws', 'http://127.0.0.1:4173/')).toBe('ws://127.0.0.1:4173/v1/twin/ws');
    expect(websocketUrl('/v1/twin/ws', 'https://demo.example/')).toBe('wss://demo.example/v1/twin/ws');
  });
  it('rejects malformed bootstrap data', () => {
    expect(() => assertBootstrap({ token: '', websocket_url: '/ws' })).toThrow(/invalid/);
  });
});
