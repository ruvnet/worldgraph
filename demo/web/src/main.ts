import './style.css';
import { PresenceLayer, SemanticVisualizer, TwinStreamClient, WorldgraphScene } from '../../../supersplat-bridge/src/index.js';
import type { WorldgraphWasmModule } from '../../../supersplat-bridge/src/wasm-bridge.js';
import { assertBootstrap, websocketUrl } from './bootstrap.js';
import { CanvasSceneBackend } from './canvas-backend.js';

const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing #${id}`);
  return element as T;
};

const canvas = byId<HTMLCanvasElement>('world');
const backend = new CanvasSceneBackend(canvas);
const scene = new WorldgraphScene(backend);
const presence = new PresenceLayer();
const visualizer = new SemanticVisualizer();
let client: TwinStreamClient | undefined;
let presenceTimer: ReturnType<typeof setInterval> | undefined;

function status(id: string, value: string): void { byId(id).textContent = value; }
function event(message: string): void {
  const row = document.createElement('li');
  const time = document.createElement('time');
  time.textContent = new Date().toLocaleTimeString();
  const text = document.createElement('span');
  text.textContent = message;
  row.append(time, text);
  const list = byId<HTMLOListElement>('events'); list.prepend(row);
  while (list.children.length > 8) list.lastElementChild?.remove();
}
function redraw(): void {
  backend.beginFrame();
  scene.sync([...visualizer.renderPrimitives(), ...presence.primitives()]);
  backend.render();
  status('nodes', String(visualizer.nodeCount()));
  status('presence', String(presence.size));
}

async function start(): Promise<void> {
  status('backend', `Canvas2D · ${'gpu' in navigator ? 'WebGPU available' : 'WebGL2 fallback available'}`);
  const moduleUrl = new URL('/wasm/worldgraph_wasm.js', window.location.href).href;
  await visualizer.initialize({ loader: async () => await import(/* @vite-ignore */ moduleUrl) as WorldgraphWasmModule });
  event('Real worldgraph WASM initialized');

  const response = await fetch('/demo/bootstrap', { cache: 'no-store' });
  if (!response.ok) throw new Error(`demo bootstrap failed (${response.status}); start server with WORLDGRAPH_DEMO_MODE=1`);
  const bootstrap = assertBootstrap(await response.json());
  status('connection', 'connecting');
  client = new TwinStreamClient(visualizer, {
    supportedProtocolVersions: [bootstrap.protocol_version],
    supportedGraphSchemaVersions: [bootstrap.graph_schema_version],
    capabilities: ['snapshot', 'delta', 'presence']
  });
  client.onPresence((updates) => { presence.apply(updates); });
  client.onDelta((seq) => {
    status('sequence', String(seq)); redraw(); event(`Applied stream sequence ${seq}`);
  });
  client.onClose(() => {
    status('connection', 'disconnected');
    byId('connection-pill').className = 'pill error'; byId('connection-pill').textContent = 'DISCONNECTED';
  });
  const session = await client.connect({ webSocket: websocketUrl(bootstrap.websocket_url, location.href), token: bootstrap.token });
  status('connection', 'live'); status('transport', session.transport); status('epoch', session.streamEpoch);
  byId('connection-pill').className = 'pill live'; byId('connection-pill').textContent = 'LIVE';
  event(`Negotiated protocol v${session.protocolVersion}`);

  let angle = 0;
  const publishPresence = () => {
    angle += 0.28;
    client?.sendPresence({ east_m: Math.cos(angle) * 3.5, north_m: Math.sin(angle) * 3.5, up_m: 0 });
  };
  publishPresence();
  presenceTimer = setInterval(publishPresence, 900);
}

start().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  status('connection', 'error'); byId('connection-pill').className = 'pill error'; byId('connection-pill').textContent = 'ERROR';
  event(message); console.error(error);
});

window.addEventListener('beforeunload', () => { if (presenceTimer) clearInterval(presenceTimer); client?.close(); scene.clear(); });
