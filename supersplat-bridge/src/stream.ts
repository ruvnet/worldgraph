import type { SemanticVisualizer } from './wasm-bridge.js';
import type { PresenceUpdate } from './types.js';
import type { EnuPoint } from './types.js';

export interface ResumeCursor { stream_epoch: string; seq: number }

export interface StreamEndpoints {
  webTransport?: string;
  webSocket: string;
  /** Short-lived audience-bound token; sent inside the encrypted channel, never in the URL. */
  token: string;
}

export interface NegotiatedSession {
  protocolVersion: number;
  capabilities: readonly string[];
  streamEpoch: string;
  transport: 'webtransport' | 'websocket';
}

export interface ClientHello {
  type: 'client_hello';
  supported_protocol_versions: number[];
  capabilities: string[];
  access_token: string;
  resume?: ResumeCursor;
}

export interface ServerHello {
  type: 'server_hello';
  protocol_version: number;
  capabilities: string[];
  stream_epoch: string;
}

export interface TwinEnvelope {
  protocol_version: number;
  stream_epoch: string;
  seq: number;
  message: { op: string; graph_schema_version?: number; [key: string]: unknown };
}

export interface StreamTransport {
  readonly kind: 'webtransport' | 'websocket';
  connect(url: string): Promise<void>;
  send(payload: string): void | Promise<void>;
  onMessage(callback: (payload: string) => void): void;
  onClose(callback: (reason?: unknown) => void): void;
  close(): void;
}

export type StreamTransportFactory = () => StreamTransport;

export interface TwinStreamClientOptions {
  webTransport?: StreamTransportFactory;
  webSocket?: StreamTransportFactory;
  supportedProtocolVersions?: readonly number[];
  supportedGraphSchemaVersions?: readonly number[];
  capabilities?: readonly string[];
  handshakeTimeoutMs?: number;
  presenceCoordinateLimitM?: number;
}

/** Ordered, epoch-scoped browser replication client with transport injection. */
export class TwinStreamClient {
  private transport: StreamTransport | null = null;
  private session: NegotiatedSession | null = null;
  private lastSeq: number | null = null;
  private awaitingSnapshot = false;
  private resume: ResumeCursor | undefined;
  private readonly deltaCallbacks = new Set<(seq: number) => void>();
  private readonly closeCallbacks = new Set<(reason?: unknown) => void>();
  private readonly presenceCallbacks = new Set<(updates: readonly PresenceUpdate[]) => void>();
  private connectResolve: ((session: NegotiatedSession) => void) | null = null;
  private connectReject: ((reason: unknown) => void) | null = null;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly viz: SemanticVisualizer, private readonly options: TwinStreamClientOptions = {}) {}

  onDelta(callback: (seq: number) => void): () => void {
    this.deltaCallbacks.add(callback);
    return () => this.deltaCallbacks.delete(callback);
  }

  onClose(callback: (reason?: unknown) => void): () => void {
    this.closeCallbacks.add(callback);
    return () => this.closeCallbacks.delete(callback);
  }

  onPresence(callback: (updates: readonly PresenceUpdate[]) => void): () => void {
    this.presenceCallbacks.add(callback);
    return () => this.presenceCallbacks.delete(callback);
  }

  async connect(endpoints: StreamEndpoints): Promise<NegotiatedSession> {
    this.close();
    const candidates: Array<{ url: string; factory: StreamTransportFactory }> = [];
    const wt = this.options.webTransport ?? browserWebTransportFactory();
    if (endpoints.webTransport && wt) candidates.push({ url: endpoints.webTransport, factory: wt });
    candidates.push({ url: endpoints.webSocket, factory: this.options.webSocket ?? (() => new BrowserWebSocketTransport()) });

    let lastError: unknown = new Error('no stream transport is available');
    for (const candidate of candidates) {
      const transport = candidate.factory();
      try {
        assertEndpoint(candidate.url, transport.kind);
        transport.onMessage((payload) => { if (this.transport === transport) this.receive(payload); });
        transport.onClose((reason) => { if (this.transport === transport) this.handleClose(reason); });
        await transport.connect(candidate.url);
        this.transport = transport;
        const session = new Promise<NegotiatedSession>((resolve, reject) => {
          this.connectResolve = resolve;
          this.connectReject = reject;
        });
        this.handshakeTimer = setTimeout(
          () => this.failHandshake(new Error('stream negotiation timed out')),
          this.options.handshakeTimeoutMs ?? 10_000
        );
        const hello: ClientHello = {
          type: 'client_hello',
          supported_protocol_versions: [...(this.options.supportedProtocolVersions ?? [1])],
          capabilities: [...(this.options.capabilities ?? ['snapshot', 'delta', 'presence'])],
          access_token: endpoints.token,
          ...(this.resume ? { resume: this.resume } : {})
        };
        await transport.send(JSON.stringify(hello));
        return await session;
      } catch (error) {
        lastError = error;
        transport.close();
        if (this.transport === transport) this.transport = null;
        this.clearHandshake();
      }
    }
    throw lastError;
  }

  /** Refresh authentication without reconnecting or placing secrets in URLs. */
  refreshToken(token: string): void {
    if (!this.transport) throw new Error('stream is not connected');
    void this.transport.send(JSON.stringify({ type: 'auth_refresh', access_token: token }));
  }

  /** Publish an ephemeral operator position; viewer identity comes from the server session. */
  sendPresence(position: EnuPoint): void {
    if (!this.transport || !this.session) throw new Error('stream is not negotiated');
    const limit = this.options.presenceCoordinateLimitM ?? 100_000;
    const values = [position.east_m, position.north_m, position.up_m];
    if (!values.every((value) => Number.isFinite(value) && Math.abs(value) <= limit)) {
      throw new Error(`presence coordinates must be finite and within ${limit}m`);
    }
    void this.transport.send(JSON.stringify({ type: 'presence_update', position }));
  }

  close(): void {
    const transport = this.transport;
    this.transport = null;
    this.session = null;
    this.connectReject?.(new Error('stream closed'));
    this.clearHandshake();
    transport?.close();
  }

  private receive(payload: string): void {
    let value: unknown;
    try { value = JSON.parse(payload); } catch { this.failHandshake(new Error('invalid stream JSON')); return; }
    if (isServerHello(value)) {
      const supported = this.options.supportedProtocolVersions ?? [1];
      if (!supported.includes(value.protocol_version)) {
        this.failHandshake(new Error(`unsupported stream protocol ${value.protocol_version}`));
        return;
      }
      this.session = {
        protocolVersion: value.protocol_version,
        capabilities: [...value.capabilities],
        streamEpoch: value.stream_epoch,
        transport: this.transport?.kind ?? 'websocket'
      };
      if (this.resume && this.resume.stream_epoch !== value.stream_epoch) {
        this.lastSeq = null;
        this.awaitingSnapshot = true;
        this.requestSnapshot('epoch_changed');
      }
      this.connectResolve?.(this.session);
      this.clearHandshake();
      return;
    }
    if (!isEnvelope(value) || !this.session) return;
    this.applyEnvelope(value);
  }

  private applyEnvelope(envelope: TwinEnvelope): void {
    if (envelope.protocol_version !== this.session?.protocolVersion) return;
    const epochChanged = envelope.stream_epoch !== this.session.streamEpoch;
    if (epochChanged) {
      this.session = { ...this.session, streamEpoch: envelope.stream_epoch };
      this.lastSeq = null;
      this.awaitingSnapshot = true;
    }

    const isSnapshot = envelope.message.op === 'snapshot';
    if (isSnapshot) {
      const schema = envelope.message.graph_schema_version;
      if (typeof schema !== 'number' || !(this.options.supportedGraphSchemaVersions ?? [1, 2]).includes(schema)) {
        this.awaitingSnapshot = true;
        this.requestSnapshot('unsupported_schema');
        return;
      }
    } else if (this.awaitingSnapshot) {
      this.requestSnapshot('epoch_changed');
      return;
    }

    if (this.lastSeq !== null) {
      if (envelope.seq <= this.lastSeq) return;
      if (envelope.seq !== this.lastSeq + 1 && !isSnapshot) {
        this.awaitingSnapshot = true;
        this.requestSnapshot('sequence_gap');
        return;
      }
    }

    if (envelope.message.op === 'presence' && isPresenceUpdates(envelope.message.updates)) {
      for (const callback of this.presenceCallbacks) callback(envelope.message.updates);
    } else {
      this.viz.applyMessage(JSON.stringify(envelope.message));
    }
    this.lastSeq = envelope.seq;
    this.resume = { stream_epoch: envelope.stream_epoch, seq: envelope.seq };
    this.awaitingSnapshot = false;
    for (const callback of this.deltaCallbacks) callback(envelope.seq);
  }

  private requestSnapshot(reason: string): void {
    void this.transport?.send(JSON.stringify({
      type: 'request_snapshot', reason, stream_epoch: this.session?.streamEpoch
    }));
  }

  private handleClose(reason?: unknown): void {
    this.transport = null;
    this.session = null;
    this.connectReject?.(reason ?? new Error('stream closed during negotiation'));
    this.clearHandshake();
    for (const callback of this.closeCallbacks) callback(reason);
  }

  private failHandshake(error: Error): void {
    this.connectReject?.(error);
    this.clearHandshake();
    this.transport?.close();
  }

  private clearHandshake(): void {
    if (this.handshakeTimer !== null) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
    this.connectResolve = null;
    this.connectReject = null;
  }
}

function assertEndpoint(url: string, kind: StreamTransport['kind']): void {
  const parsed = new URL(url);
  const expected = kind === 'webtransport' ? 'https:' : 'wss:';
  const localWebSocket = kind === 'websocket' && parsed.protocol === 'ws:' &&
    (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]');
  if (parsed.protocol !== expected && !localWebSocket) {
    throw new Error(`${kind} endpoint must use ${expected} (ws: is allowed only on loopback)`);
  }
}

function isServerHello(value: unknown): value is ServerHello {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return v.type === 'server_hello' && typeof v.protocol_version === 'number' &&
    Array.isArray(v.capabilities) && v.capabilities.every((x) => typeof x === 'string') &&
    typeof v.stream_epoch === 'string';
}

function isEnvelope(value: unknown): value is TwinEnvelope {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.protocol_version === 'number' && typeof v.stream_epoch === 'string' &&
    Number.isSafeInteger(v.seq) && (v.seq as number) >= 0 && !!v.message && typeof v.message === 'object' &&
    typeof (v.message as Record<string, unknown>).op === 'string';
}

function isPresenceUpdates(value: unknown): value is PresenceUpdate[] {
  return Array.isArray(value) && value.every((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const update = entry as Record<string, unknown>;
    const point = update.position as Record<string, unknown> | undefined;
    return Number.isSafeInteger(update.viewer_id) && !!point &&
      typeof update.active === 'boolean' &&
      Number.isFinite(point.east_m) && Number.isFinite(point.north_m) && Number.isFinite(point.up_m);
  });
}

/** Browser WebSocket implementation; tests inject deterministic transports. */
export class BrowserWebSocketTransport implements StreamTransport {
  readonly kind = 'websocket' as const;
  private socket: WebSocket | null = null;
  private message: (payload: string) => void = () => undefined;
  private closed: (reason?: unknown) => void = () => undefined;

  connect(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      this.socket = socket;
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error('WebSocket connection failed')), { once: true });
      socket.addEventListener('message', (event) => { if (typeof event.data === 'string') this.message(event.data); });
      socket.addEventListener('close', (event) => this.closed(event.reason));
    });
  }
  send(payload: string): void { this.socket?.send(payload); }
  onMessage(callback: (payload: string) => void): void { this.message = callback; }
  onClose(callback: (reason?: unknown) => void): void { this.closed = callback; }
  close(): void { this.socket?.close(); this.socket = null; }
}

function browserWebTransportFactory(): StreamTransportFactory | undefined {
  const ctor = (globalThis as { WebTransport?: unknown }).WebTransport;
  return typeof ctor === 'function' ? () => new BrowserWebTransportTransport(ctor as WebTransportCtor) : undefined;
}

interface WebTransportLike {
  ready: Promise<void>;
  closed: Promise<unknown>;
  createBidirectionalStream(): Promise<{
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
  }>;
  close(): void;
}
type WebTransportCtor = new (url: string) => WebTransportLike;

/** Newline-delimited JSON over one reliable WebTransport bidirectional stream. */
export class BrowserWebTransportTransport implements StreamTransport {
  readonly kind = 'webtransport' as const;
  private session: WebTransportLike | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private message: (payload: string) => void = () => undefined;
  private closed: (reason?: unknown) => void = () => undefined;
  constructor(private readonly Ctor: WebTransportCtor, private readonly maxFrameBytes = 1024 * 1024) {}
  async connect(url: string): Promise<void> {
    const session = new this.Ctor(url);
    this.session = session;
    await session.ready;
    const stream = await session.createBidirectionalStream();
    this.writer = stream.writable.getWriter();
    void this.read(stream.readable).catch((error) => { this.closed(error); this.close(); });
    void session.closed.then(() => this.closed(), (error) => this.closed(error));
  }
  async send(payload: string): Promise<void> {
    if (!this.writer) throw new Error('WebTransport stream is not connected');
    await this.writer.write(new TextEncoder().encode(`${payload}\n`));
  }
  onMessage(callback: (payload: string) => void): void { this.message = callback; }
  onClose(callback: (reason?: unknown) => void): void { this.closed = callback; }
  close(): void { this.writer?.releaseLock(); this.writer = null; this.session?.close(); this.session = null; }
  private async read(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        let newline: number;
        while ((newline = pending.indexOf('\n')) >= 0) {
          const frame = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          if (frame.length > this.maxFrameBytes) throw new Error('WebTransport frame exceeds size limit');
          if (frame) this.message(frame);
        }
        if (pending.length > this.maxFrameBytes) throw new Error('WebTransport frame exceeds size limit');
      }
    } finally { reader.releaseLock(); }
  }
}
