import { describe, expect, it } from 'vitest';
import { TwinStreamClient, type StreamTransport } from '../src/stream.js';
import { SemanticVisualizer } from '../src/wasm-bridge.js';
import { FakeBridge } from './fake-bridge.js';

class MockTransport implements StreamTransport {
  sent: string[] = [];
  private message: (payload: string) => void = () => undefined;
  private closed: (reason?: unknown) => void = () => undefined;
  constructor(readonly kind: 'webtransport' | 'websocket', private readonly fails = false, private readonly responds = true) {}
  async connect(_url: string): Promise<void> { if (this.fails) throw new Error('unavailable'); }
  send(payload: string): void {
    this.sent.push(payload);
    const parsed = JSON.parse(payload) as { type?: string };
    if (parsed.type === 'client_hello' && this.responds) {
      this.emit({ type: 'server_hello', protocol_version: 1, capabilities: ['delta'], stream_epoch: 'epoch-a' });
    }
  }
  onMessage(callback: (payload: string) => void): void { this.message = callback; }
  onClose(callback: (reason?: unknown) => void): void { this.closed = callback; }
  close(): void { /* deterministic test transport */ }
  emit(value: unknown): void { this.message(JSON.stringify(value)); }
}

async function setup() {
  const bridge = new FakeBridge();
  const viz = new SemanticVisualizer();
  await viz.initialize({ loader: async () => ({
    default: async () => undefined,
    WorldgraphBridge: Object.assign(function () { return bridge; }, { empty: () => bridge }) as never
  }) });
  return { bridge, viz };
}

function envelope(seq: number, message: Record<string, unknown>, epoch = 'epoch-a') {
  return { protocol_version: 1, stream_epoch: epoch, seq, message };
}

describe('TwinStreamClient', () => {
  it('falls back to WebSocket and negotiates without putting its token in the URL', async () => {
    const { viz } = await setup();
    const wt = new MockTransport('webtransport', true);
    const ws = new MockTransport('websocket');
    const client = new TwinStreamClient(viz, { webTransport: () => wt, webSocket: () => ws });
    const session = await client.connect({
      webTransport: 'https://stream.example/twin', webSocket: 'wss://stream.example/twin', token: 'secret'
    });
    expect(session.transport).toBe('websocket');
    expect(JSON.parse(ws.sent[0]!)).toMatchObject({ type: 'client_hello', access_token: 'secret' });
  });

  it('permits insecure WebSocket only for a loopback demo', async () => {
    const { viz } = await setup();
    const local = new MockTransport('websocket');
    const client = new TwinStreamClient(viz, { webSocket: () => local });
    await expect(client.connect({ webSocket: 'ws://127.0.0.1:8080/v1/twin/ws', token: 'demo' }))
      .resolves.toMatchObject({ transport: 'websocket' });
    const remote = new TwinStreamClient(viz, { webSocket: () => new MockTransport('websocket') });
    await expect(remote.connect({ webSocket: 'ws://stream.example/v1/twin/ws', token: 'bad' }))
      .rejects.toThrow(/loopback/);
  });

  it('falls back when WebTransport connects but never negotiates', async () => {
    const { viz } = await setup();
    const wt = new MockTransport('webtransport', false, false);
    const ws = new MockTransport('websocket');
    const client = new TwinStreamClient(viz, {
      webTransport: () => wt, webSocket: () => ws, handshakeTimeoutMs: 1
    });
    const session = await client.connect({
      webTransport: 'https://stream.example/twin', webSocket: 'wss://stream.example/twin', token: 'secret'
    });
    expect(session.transport).toBe('websocket');
  });

  it('applies ordered messages once and requests a snapshot on a gap', async () => {
    const { bridge, viz } = await setup();
    const ws = new MockTransport('websocket');
    const client = new TwinStreamClient(viz, { webSocket: () => ws });
    const applied: number[] = [];
    client.onDelta((seq) => applied.push(seq));
    await client.connect({ webSocket: 'wss://stream.example/twin', token: 'token' });
    ws.emit(envelope(1, { op: 'snapshot', graph_schema_version: 2, rvf_json: '{"nodes":[]}' }));
    ws.emit(envelope(2, { op: 'remove_node', id: 3 }));
    ws.emit(envelope(2, { op: 'remove_node', id: 3 }));
    ws.emit(envelope(4, { op: 'remove_node', id: 4 }));
    expect(bridge.appliedMessages).toHaveLength(2);
    expect(applied).toEqual([1, 2]);
    expect(ws.sent.map((x) => JSON.parse(x)).at(-1)).toMatchObject({ type: 'request_snapshot', reason: 'sequence_gap' });
  });

  it('discards a new epoch tail until a compatible snapshot arrives', async () => {
    const { bridge, viz } = await setup();
    const ws = new MockTransport('websocket');
    const client = new TwinStreamClient(viz, { webSocket: () => ws, supportedGraphSchemaVersions: [2] });
    await client.connect({ webSocket: 'wss://stream.example/twin', token: 'token' });
    ws.emit(envelope(1, { op: 'snapshot', graph_schema_version: 2, rvf_json: '{"nodes":[]}' }));
    ws.emit(envelope(1, { op: 'remove_node', id: 2 }, 'epoch-b'));
    ws.emit(envelope(2, { op: 'snapshot', graph_schema_version: 99, rvf_json: '{"nodes":[]}' }, 'epoch-b'));
    ws.emit(envelope(3, { op: 'snapshot', graph_schema_version: 2, rvf_json: '{"nodes":[]}' }, 'epoch-b'));
    expect(bridge.appliedMessages).toHaveLength(2);
    expect(ws.sent.map((x) => JSON.parse(x)).filter((x) => x.type === 'request_snapshot')).toHaveLength(2);
  });

  it('routes ephemeral presence without mutating the WASM graph', async () => {
    const { bridge, viz } = await setup();
    const ws = new MockTransport('websocket');
    const client = new TwinStreamClient(viz, { webSocket: () => ws });
    const seen: unknown[] = [];
    client.onPresence((updates) => seen.push(...updates));
    await client.connect({ webSocket: 'wss://stream.example/twin', token: 'token' });
    ws.emit(envelope(1, { op: 'snapshot', graph_schema_version: 2, rvf_json: '{"nodes":[]}' }));
    ws.emit(envelope(2, { op: 'presence', updates: [{ viewer_id: 9, position: { east_m: 1, north_m: 2, up_m: 3 }, active: true }] }));
    expect(seen).toHaveLength(1);
    expect(bridge.appliedMessages).toHaveLength(1);
    client.sendPresence({ east_m: 1, north_m: 2, up_m: 3 });
    expect(JSON.parse(ws.sent.at(-1)!)).toEqual({
      type: 'presence_update', position: { east_m: 1, north_m: 2, up_m: 3 }
    });
    expect(() => client.sendPresence({ east_m: Number.NaN, north_m: 0, up_m: 0 })).toThrow(/finite/);
  });
});
