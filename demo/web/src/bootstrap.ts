export interface DemoBootstrap {
  token: string;
  expires_at: number;
  websocket_url: string;
  protocol_version: number;
  graph_schema_version: number;
}

export function websocketUrl(value: string, pageUrl: string): string {
  const page = new URL(pageUrl);
  const url = new URL(value, page);
  if (url.protocol === 'http:') url.protocol = 'ws:';
  if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new Error('invalid bootstrap WebSocket URL');
  return url.href;
}

export function assertBootstrap(value: unknown): DemoBootstrap {
  if (!value || typeof value !== 'object') throw new Error('invalid demo bootstrap response');
  const data = value as Record<string, unknown>;
  if (typeof data.token !== 'string' || data.token.length === 0 ||
      typeof data.websocket_url !== 'string' ||
      !Number.isSafeInteger(data.expires_at) ||
      !Number.isSafeInteger(data.protocol_version) ||
      !Number.isSafeInteger(data.graph_schema_version)) {
    throw new Error('invalid demo bootstrap response');
  }
  return data as unknown as DemoBootstrap;
}
