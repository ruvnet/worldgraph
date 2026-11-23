import * as T from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SparkRenderer } from '@sparkjsdev/spark';
import { createCoastalScene } from './coast';
import { HybridGraph } from './graph';
import { projectEvidence, type EvidenceContext, type EvidenceSnapshot } from './evidence';
import './style.css';

const app = document.querySelector<HTMLDivElement>('#app')!;
const base = import.meta.env.BASE_URL;
app.innerHTML = `
<main class="coast-app" data-source="synthetic">
  <canvas id="coast" class="coast-canvas" tabindex="0" aria-label="Interactive synthetic coastal world. Drag to orbit, scroll to zoom, use W A S D to move."></canvas>
  <header class="coast-top">
    <div class="coast-brand"><span class="coast-mark" aria-hidden="true"><i></i><i></i><i></i></span><div>RuLab<small>WORLDGRAPH / REALITY</small></div></div>
    <nav aria-label="World actions"><a class="coast-btn" href="${base}">Laboratory</a><button class="coast-btn" id="export-coast">Export evidence</button><button class="coast-btn" id="coast-fullscreen" aria-label="Toggle fullscreen">Full screen</button></nav>
  </header>
  <section class="coast-title"><span class="coast-eyebrow">EXPERIMENT 002 / COASTAL WORLD</span><h1>A world with<br>room to move.</h1><p>Gaussian detail. Physical geometry.<br>One persistent, navigable space.</p><span class="coast-provenance">SYNTHETIC SCENE · NO SENSORS CONNECTED</span></section>
  <aside class="coast-panel" aria-label="Hybrid renderer controls">
    <header><h2>THE HYBRID WORLD</h2><span>3 LAYERS</span></header>
    <button class="coast-layer" id="layer-splats" aria-pressed="true"><span class="layer-symbol" aria-hidden="true">∴</span><span><b>Gaussian appearance</b><small>Authored foliage and fine detail</small></span><span class="coast-switch" aria-hidden="true"></span></button>
    <button class="coast-layer" id="layer-meshes" aria-pressed="true"><span class="layer-symbol" aria-hidden="true">◇</span><span><b>Mesh geometry</b><small>Surfaces, actors and shadows</small></span><span class="coast-switch" aria-hidden="true"></span></button>
    <button class="coast-layer" id="layer-evidence" aria-pressed="false"><span class="layer-symbol" aria-hidden="true">◎</span><span><b>Evidence overlay</b><small>Separate synthetic test feed</small></span><span class="coast-switch" aria-hidden="true"></span></button>
    <div class="coast-divider"></div>
    <div class="coast-measures"><div><strong id="coast-fps">…</strong><small>MEASURED FPS</small></div><div><strong id="coast-p95">…</strong><small>P95 FRAME / MS</small></div></div>
    <p class="coast-runtime"><b id="coast-splats">Preparing splats</b><br><span id="coast-graph">Loading Rust graph</span><br><span id="coast-device">Checking renderer</span></p>
    <label class="coast-quality">Rendering detail<select id="coast-quality" aria-label="Rendering detail"><option value="auto">Adaptive</option><option value="performance">Performance</option><option value="quality">Quality</option></select></label>
    <section class="coast-evidence" id="evidence-panel" hidden>
      <label>Synthetic evidence case<select id="evidence-case" aria-label="Synthetic evidence case"><option value="located">Located actors</option><option value="count">Count only</option><option value="blackout">Expired source</option><option value="registration">Registration mismatch</option><option value="privacy">Privacy epoch changed</option></select></label>
      <p id="evidence-state" role="status"></p><button class="coast-btn" id="hold-evidence" aria-pressed="false">Hold feed to test expiry</button>
    </section>
  </aside>
  <div class="coast-mobile" aria-label="Camera movement"><button class="coast-btn" data-move="-1" aria-label="Move camera left">←</button><button class="coast-btn" data-move="1" aria-label="Move camera right">→</button></div>
  <footer class="coast-bottom">
    <div class="coast-transport"><div class="coast-transport-top"><div class="coast-route">COAST / A SYNTHETIC REPLAY<span>STABLE IDENTITIES · INDEPENDENT CAMERA · LOCAL METRES</span></div><span class="coast-time" id="coast-time">00:00.0 / 02:00</span></div><div class="coast-replay"><button class="coast-play" id="coast-play" aria-label="Pause synthetic replay">Pause</button><input id="coast-time-input" aria-label="Synthetic replay time" type="range" min="0" max="120" step="0.1" value="0"></div><div class="coast-help">DRAG TO ORBIT · SCROLL TO ZOOM · W A S D TO MOVE · Q / E TO RISE · PAUSE TO INSPECT</div></div>
    <div class="coast-preset-bar" aria-label="Camera presets"><button class="coast-btn" data-preset="overview" aria-pressed="true">Coast</button><button class="coast-btn" data-preset="promenade" aria-pressed="false">Promenade</button><button class="coast-btn" data-preset="shore" aria-pressed="false">Shoreline</button><p>APPEARANCE ≠ OBSERVATION</p></div>
  </footer>
  <div class="coast-loading" id="coast-loading" role="status">Preparing the coastal world.<br>Loading geometry and Gaussian renderer.</div>
</main>`;

const $ = <E extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as E;
const canvas = $<HTMLCanvasElement>('coast');
const output = $('coast-loading');
const context: EvidenceContext = {
  tenantId: 'synthetic-local', spaceId: 'coast-demo', calibrationId: 'authored-metres-v1',
  privacyEpoch: 1, registrationId: 'coast-synthetic-registration-v1', maxAgeMs: 750,
};
const PRESETS = {
  overview: { position: [42, 24, 55], target: [-24, 5, -28] },
  promenade: { position: [22, 5.5, 11], target: [-16, 3, -18] },
  shore: { position: [54, 7, 45], target: [3, 3, -29] },
} as const;

type EvidenceCase = 'located' | 'count' | 'blackout' | 'registration' | 'privacy';
type Quality = 'auto' | 'performance' | 'quality';
type Diagnostics = {
  schema: 'worldgraph.rulab.hybrid.evidence.v1'; source: 'synthetic'; sensorConnected: false;
  backend: string; renderer: string; resolution: [number, number]; pixelRatio: number;
  time: number; camera: number[]; target: number[];
  layers: { splats: boolean; meshes: boolean; evidence: boolean };
  renderedLayers: { splats: boolean; staticMeshes: boolean; dynamicMeshes: boolean; evidence: boolean };
  splatCount: number; drawCalls: number; frameSamples: number; frameTimesMs: number[];
  fps: number | null; p95FrameMs: number | null;
  evidence: ReturnType<typeof projectEvidence>; evidenceSource: 'synthetic'; feedHeld: boolean;
  actors: ReturnType<ReturnType<typeof createCoastalScene>['actorStates']>;
  graphStatus: string; graphNodes: number; collisionProxyCount: number; quality: Quality;
};
declare global { interface Window { __coast?: { diagnostics(): Diagnostics; graphJson(): string; }; } }

function download(filename: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function start() {
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, powerPreference: 'high-performance' });
  if (!gl) throw new Error('This scene needs WebGL2. No reference image is substituted for a working renderer.');
  const renderer = new T.WebGLRenderer({ canvas, context: gl, antialias: false });
  const cleanup: Array<() => void> = [() => renderer.dispose()];
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const release of cleanup.reverse()) { try { release(); } catch { /* Release remaining independent resources. */ } }
    delete window.__coast;
  };
  try {
    let startupShaderFailed = false;
    renderer.debug.onShaderError = () => { startupShaderFailed = true; };
    renderer.outputColorSpace = T.SRGBColorSpace;
    renderer.toneMapping = T.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = T.PCFSoftShadowMap;
    const scene = new T.Scene();
    scene.background = new T.Color(0xb9d2cf);
    scene.fog = new T.FogExp2(0xc9d9cb, .0038);
    const camera = new T.PerspectiveCamera(52, 1, .15, 650);
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true; controls.dampingFactor = .07;
    controls.minDistance = 2; controls.maxDistance = 210;
    controls.maxPolarAngle = Math.PI * .485;
    controls.minPolarAngle = .12;
    controls.screenSpacePanning = false;
    cleanup.push(() => controls.dispose());
    const preset = (name: keyof typeof PRESETS) => {
      camera.position.fromArray(PRESETS[name].position);
      controls.target.fromArray(PRESETS[name].target); controls.update();
      document.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.preset === name)));
    };
    preset('overview');

    const sky = new T.Mesh(new T.SphereGeometry(500, 32, 16), new T.ShaderMaterial({
      side: T.BackSide, depthWrite: false,
      uniforms: { top: { value: new T.Color(0x77b9d4) }, horizon: { value: new T.Color(0xece6c7) } },
      vertexShader: 'varying vec3 vDirection;void main(){vDirection=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
      fragmentShader: 'uniform vec3 top;uniform vec3 horizon;varying vec3 vDirection;void main(){vec3 n=normalize(vDirection);vec3 c=mix(horizon,top,smoothstep(-.04,.9,n.y));float sun=pow(max(dot(n,normalize(vec3(-.55,.55,.2))),0.),800.);gl_FragColor=vec4(c+sun*vec3(1.,.87,.56),1.);}',
    }));
    scene.add(sky);
    cleanup.push(() => { sky.geometry.dispose(); sky.material.dispose(); });
    scene.add(new T.HemisphereLight(0xd9f1f1, 0xb19770, 2));
    const sun = new T.DirectionalLight(0xffeccb, 3.4);
    sun.position.set(-50, 100, 35); sun.target.position.set(-5, 0, -10);
    sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -90, right: 90, top: 100, bottom: -80, near: 1, far: 250 });
    sun.shadow.normalBias = .12; sun.shadow.bias = -.0003;
    scene.add(sun, sun.target); cleanup.push(() => sun.shadow.map?.dispose());
    const environmentScene = new T.Scene(); environmentScene.add(sky.clone());
    const pmrem = new T.PMREMGenerator(renderer);
    const environment = pmrem.fromScene(environmentScene, .08, .1, 650);
    scene.environment = environment.texture; scene.environmentIntensity = .6;
    pmrem.dispose(); cleanup.push(() => environment.dispose());
    if (startupShaderFailed) throw new Error('GPU environment shader initialization failed.');

    const coast = createCoastalScene(); cleanup.push(() => coast.dispose());
    const spark = new SparkRenderer({ renderer, maxStdDev: Math.sqrt(5), minSortIntervalMs: 30, lodSplatCount: 80_000, maxPagedSplats: 65536 });
    cleanup.push(() => spark.dispose());
    scene.add(spark, coast.staticMeshes, coast.dynamicMeshes, coast.splats);
    await coast.splats.initialized;
    const evidenceLayer = new T.Group(); evidenceLayer.name = 'Synthetic evidence overlay';
    const markers = new Map<string, T.Group>(); scene.add(evidenceLayer);
    const markerGeometry = new T.TorusGeometry(1, .022, 5, 40);
    const markerMaterial = new T.MeshBasicMaterial({ color: 0xcaff8a, transparent: true, opacity: .92, depthTest: true });
    const markerStemGeometry = new T.CylinderGeometry(.018, .018, 2.8, 5);
    cleanup.push(() => { markerGeometry.dispose(); markerMaterial.dispose(); markerStemGeometry.dispose(); });

    const graph = new HybridGraph(); cleanup.push(() => graph.dispose());
    void graph.initialize().then(() => {
      if (!disposed) { graph.sync(time, coast.actorStates(time)); updateGraphLabel(); }
    }).catch(() => { if (!disposed) $('coast-graph').textContent = 'Rust graph unavailable'; });

    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const device = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)).slice(0, 220);
    const software = /swiftshader|llvmpipe|software/i.test(device);
    $('coast-device').textContent = software ? 'WebGL2 · software rendering' : 'WebGL2 · this device only';
    $('coast-device').title = device;
    $('coast-splats').textContent = `${coast.splatCount.toLocaleString()} authored Gaussians`;

    const layers = { splats: true, meshes: true, evidence: false };
    let quality: Quality = 'auto', ratio = Math.min(devicePixelRatio || 1, 1.25);
    let time = 0, playing = !matchMedia('(prefers-reduced-motion: reduce)').matches;
    let caseName: EvidenceCase = 'located', held = false, snapshot: EvidenceSnapshot | undefined;
    let projection = projectEvidence(null, context, Date.now());
    let lastFeed = -Infinity, lastGraph = -Infinity, lastUi = 0, lastFrame = 0, lastAdjust = 0, raf = 0;
    const samples: number[] = [];
    const keys = new Set<string>();
    const navKeys = new Set(['w', 'a', 's', 'd', 'q', 'e']);

    function resize() {
      const width = Math.max(1, canvas.clientWidth), height = Math.max(1, canvas.clientHeight);
      renderer.setPixelRatio(ratio); renderer.setSize(width, height, false);
      camera.aspect = width / height; camera.updateProjectionMatrix();
      samples.length = 0; lastFrame = 0;
    }
    const observer = new ResizeObserver(resize); observer.observe(canvas); cleanup.push(() => observer.disconnect()); resize();
    function updateLayers() {
      samples.length = 0; lastFrame = 0;
      coast.splats.visible = layers.splats;
      coast.staticMeshes.visible = coast.dynamicMeshes.visible = layers.meshes;
      evidenceLayer.visible = layers.evidence;
      $('evidence-panel').hidden = !layers.evidence;
      for (const key of ['splats', 'meshes', 'evidence'] as const) $(`layer-${key}`).setAttribute('aria-pressed', String(layers[key]));
      canvas.dataset.splatsVisible = String(layers.splats);
      canvas.dataset.meshesVisible = String(layers.meshes);
      canvas.dataset.evidenceVisible = String(layers.evidence);
    }
    function updateGraphLabel() {
      $('coast-graph').textContent = graph.ready ? `Rust / WASM · ${graph.nodeCount()} synthetic nodes` : 'Rust graph unavailable';
      canvas.dataset.graphStatus = graph.status;
    }
    function fixture(now: number): EvidenceSnapshot {
      const captured = caseName === 'blackout' ? now - 2500 : now;
      const validUntil = captured + 750;
      return {
        schema: 'worldgraph.hybrid.evidence.v1', source: 'synthetic',
        tenantId: context.tenantId, spaceId: context.spaceId, calibrationId: context.calibrationId,
        privacyEpoch: caseName === 'privacy' ? context.privacyEpoch + 1 : context.privacyEpoch,
        registrationId: caseName === 'registration' ? 'unaligned-capture' : context.registrationId,
        coordinateSystem: 'right-handed-y-up', units: 'metres', capturedAtMs: captured, validUntilMs: validUntil,
        regions: caseName === 'count' ? [{ id: 'promenade-count', evidence: 'count-only', count: 3, capturedAtMs: captured, validUntilMs: validUntil }]
          : coast.actorStates(time).map(actor => ({ id: actor.id, evidence: 'estimated' as const, position: actor.position, radiusM: .85, capturedAtMs: captured, validUntilMs: validUntil })),
      };
    }
    function syncEvidence(now: number) {
      if (!held && now - lastFeed >= 150) { snapshot = fixture(now); lastFeed = now; }
      projection = projectEvidence(snapshot, context, now);
      for (const marker of markers.values()) marker.visible = false;
      for (const sample of projection.markers) {
        let marker = markers.get(sample.id);
        if (!marker) {
          marker = new T.Group();
          const ring = new T.Mesh(markerGeometry, markerMaterial); ring.rotation.x = Math.PI / 2; ring.position.y = .16;
          const stem = new T.Mesh(markerStemGeometry, markerMaterial); stem.position.y = 1.4;
          marker.add(ring, stem); markers.set(sample.id, marker); evidenceLayer.add(marker);
        }
        marker.position.fromArray(sample.position); marker.scale.set(sample.radiusM, 1, sample.radiusM); marker.visible = true;
      }
      canvas.dataset.markers = String(projection.markers.length);
      canvas.dataset.counts = String(projection.counts.reduce((sum, count) => sum + count.count, 0));
      canvas.dataset.evidenceRejected = String(projection.rejected);
      canvas.dataset.evidenceCase = caseName;
    }
    function frameStats() {
      if (samples.length === 0) return { fps: null, p95FrameMs: null };
      const sorted = [...samples].sort((a, b) => a - b);
      const recent = samples.slice(-60);
      return { fps: 1000 / (recent.reduce((sum, sample) => sum + sample, 0) / recent.length), p95FrameMs: sorted[Math.ceil(sorted.length * .95) - 1]! };
    }
    function diagnostics(): Diagnostics {
      return {
        schema: 'worldgraph.rulab.hybrid.evidence.v1', source: 'synthetic', sensorConnected: false,
        backend: 'webgl2', renderer: device, resolution: [canvas.width, canvas.height], pixelRatio: ratio,
        time, camera: camera.position.toArray(), target: controls.target.toArray(), layers: { ...layers },
        renderedLayers: { splats: coast.splats.visible, staticMeshes: coast.staticMeshes.visible, dynamicMeshes: coast.dynamicMeshes.visible, evidence: evidenceLayer.visible },
        splatCount: coast.splatCount, drawCalls: renderer.info.render.calls, frameSamples: samples.length,
        frameTimesMs: [...samples], ...frameStats(), evidence: structuredClone(projection), evidenceSource: 'synthetic', feedHeld: held,
        actors: coast.actorStates(time), graphStatus: graph.status, graphNodes: graph.ready ? graph.nodeCount() : 0,
        collisionProxyCount: coast.collisionBoxes.length, quality,
      };
    }
    window.__coast = { diagnostics, graphJson: () => graph.exportJson() };

    function renderUi() {
      const stats = frameStats();
      $('coast-fps').textContent = stats.fps === null ? '…' : stats.fps.toFixed(0);
      $('coast-p95').textContent = stats.p95FrameMs === null ? '…' : stats.p95FrameMs.toFixed(1);
      $('coast-time').textContent = `${Math.floor(time / 60).toString().padStart(2, '0')}:${(time % 60).toFixed(1).padStart(4, '0')} / 02:00`;
      $<HTMLInputElement>('coast-time-input').value = String(time);
      const count = projection.counts.reduce((sum, region) => sum + region.count, 0);
      $('evidence-state').textContent = projection.rejected ? `Overlay withheld: ${projection.reason}`
        : projection.counts.length ? `${count} reported in synthetic fixture. Position unknown. No located markers.`
          : `${projection.markers.length} synthetic position markers. Source age ${Math.round(projection.sourceAgeMs ?? 0)} ms.`;
      canvas.dataset.frameSamples = String(samples.length); canvas.dataset.time = time.toFixed(3);
      updateGraphLabel();
    }
    function updatePlay() {
      $('coast-play').textContent = playing ? 'Pause' : 'Play';
      $('coast-play').setAttribute('aria-label', `${playing ? 'Pause' : 'Play'} synthetic replay`);
    }
    function bind<E extends HTMLElement>(element: E, event: string, listener: EventListener) {
      element.addEventListener(event, listener); cleanup.push(() => element.removeEventListener(event, listener));
    }
    for (const layer of ['splats', 'meshes', 'evidence'] as const) bind($(`layer-${layer}`), 'click', () => { layers[layer] = !layers[layer]; updateLayers(); });
    bind($('coast-play'), 'click', () => { playing = !playing; updatePlay(); });
    bind($('coast-time-input'), 'input', () => {
      playing = false; updatePlay(); time = Number($<HTMLInputElement>('coast-time-input').value);
      lastGraph = lastFeed = -Infinity; coast.update(time); syncEvidence(Date.now()); renderUi();
    });
    bind($('evidence-case'), 'change', () => {
      caseName = $<HTMLSelectElement>('evidence-case').value as EvidenceCase;
      held = false; lastFeed = -Infinity; $('hold-evidence').textContent = 'Hold feed to test expiry';
      $('hold-evidence').setAttribute('aria-pressed', 'false'); syncEvidence(Date.now()); renderUi();
    });
    bind($('hold-evidence'), 'click', () => {
      held = !held; $('hold-evidence').setAttribute('aria-pressed', String(held));
      $('hold-evidence').textContent = held ? 'Resume synthetic feed' : 'Hold feed to test expiry';
      if (!held) lastFeed = -Infinity;
    });
    bind($('coast-quality'), 'change', () => {
      quality = $<HTMLSelectElement>('coast-quality').value as Quality;
      ratio = Math.min(devicePixelRatio || 1, quality === 'quality' ? 1.5 : quality === 'performance' ? .65 : 1.25);
      renderer.shadowMap.enabled = quality !== 'performance'; resize(); samples.length = 0;
    });
    document.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach(button => bind(button, 'click', () => preset(button.dataset.preset as keyof typeof PRESETS)));
    const acceptedCamera = camera.position.clone(), acceptedTarget = controls.target.clone();
    function permittedPosition(p: T.Vector3) {
      if (p.y < 1.6 || p.y > 150 || Math.abs(p.x) > 240 || Math.abs(p.z) > 260) return false;
      return !coast.collisionBoxes.some(box => p.x > box.min[0] - .35 && p.x < box.max[0] + .35 && p.y > box.min[1] - .35 && p.y < box.max[1] + .35 && p.z > box.min[2] - .35 && p.z < box.max[2] + .35);
    }
    function moveCamera(right: number, forward: number, up: number, distance: number) {
      const heading = new T.Vector3(); camera.getWorldDirection(heading); heading.y = 0;
      if (heading.lengthSq() < .001) heading.set(0, 0, -1); heading.normalize();
      const sideways = new T.Vector3().crossVectors(heading, camera.up).normalize();
      const delta = heading.multiplyScalar(forward * distance).addScaledVector(sideways, right * distance); delta.y = up * distance;
      const target = camera.position.clone().add(delta);
      // Bound each step so keyboard movement cannot tunnel through the authored building proxies.
      const steps = Math.max(1, Math.ceil(delta.length() / .2));
      for (let step = 1; step <= steps; step++) if (!permittedPosition(camera.position.clone().lerp(target, step / steps))) return;
      camera.position.copy(target); controls.target.add(delta); controls.update();
    }
    document.querySelectorAll<HTMLButtonElement>('[data-move]').forEach(button => bind(button, 'click', () => moveCamera(Number(button.dataset.move), 0, 0, 2)));
    const keyDown = (event: KeyboardEvent) => {
      if (event.target !== canvas || !navKeys.has(event.key.toLowerCase())) return;
      event.preventDefault(); keys.add(event.key.toLowerCase());
    };
    const keyUp = (event: KeyboardEvent) => keys.delete(event.key.toLowerCase());
    const blur = () => { keys.clear(); lastFrame = 0; };
    window.addEventListener('keydown', keyDown); window.addEventListener('keyup', keyUp); window.addEventListener('blur', blur);
    cleanup.push(() => { window.removeEventListener('keydown', keyDown); window.removeEventListener('keyup', keyUp); window.removeEventListener('blur', blur); });
    bind(canvas, 'pointerdown', () => canvas.focus({ preventScroll: true }));
    bind($('export-coast'), 'click', () => {
      if (graph.ready) { try { graph.sync(time, coast.actorStates(time)); } catch { updateGraphLabel(); } }
      download('rulab-coast-evidence.json', {
      ...diagnostics(), capturedAt: new Date().toISOString(),
      limitations: ['Authored geometry and analytic motion; no live sensing, capture reconstruction or learned dynamics.', 'Frame measurements apply only to this device, resolution and scene.', 'Evidence projection validates display shape; it does not authenticate or authorize a source.'],
      rustGraph: graph.ready ? JSON.parse(graph.exportJson()) : null,
      });
    });
    bind($('coast-fullscreen'), 'click', () => {
      const action = document.fullscreenElement ? document.exitFullscreen() : app.requestFullscreen?.();
      void action?.catch(() => { output.textContent = 'Full screen is unavailable in this browser.'; output.hidden = false; });
    });
    const contextLost = (event: Event) => { event.preventDefault(); fail('GPU context lost. Reload to restore the scene.'); };
    canvas.addEventListener('webglcontextlost', contextLost); cleanup.push(() => canvas.removeEventListener('webglcontextlost', contextLost));
    function fail(message: string) { dispose(); output.textContent = message; output.hidden = false; canvas.dataset.backend = 'unavailable'; }
    renderer.debug.onShaderError = () => fail('A required GPU shader failed. The renderer stopped.');
    cleanup.push(() => cancelAnimationFrame(raf));
    const onPageHide = () => dispose(); window.addEventListener('pagehide', onPageHide); cleanup.push(() => window.removeEventListener('pagehide', onPageHide));
    // A BFCache restores the disposed DOM without rerunning the entry module.
    const onPageShow = (event: PageTransitionEvent) => { if (event.persisted && disposed) location.reload(); };
    window.addEventListener('pageshow', onPageShow);
    function loop(stamp: number) {
      if (disposed) return;
      raf = requestAnimationFrame(loop);
      if (document.hidden) { lastFrame = 0; keys.clear(); return; }
      const interval = lastFrame ? stamp - lastFrame : 0; lastFrame = stamp;
      const dt = Math.min(interval / 1000, .1);
      if (playing) time = (time + interval / 1000) % 120;
      coast.update(time);
      if (keys.size) moveCamera(Number(keys.has('d')) - Number(keys.has('a')), Number(keys.has('w')) - Number(keys.has('s')), Number(keys.has('e')) - Number(keys.has('q')), dt * 12);
      controls.update();
      if (!permittedPosition(camera.position)) {
        camera.position.copy(acceptedCamera); controls.target.copy(acceptedTarget); camera.lookAt(acceptedTarget);
      } else { acceptedCamera.copy(camera.position); acceptedTarget.copy(controls.target); }
      const now = Date.now(); syncEvidence(now);
      if (graph.ready && stamp - lastGraph >= 200) {
        try { graph.sync(time, coast.actorStates(time)); } catch { updateGraphLabel(); }
        lastGraph = stamp;
      }
      try { renderer.render(scene, camera); } catch { fail('Rendering failed. Reload to restore the scene.'); return; }
      if (disposed) return;
      if (interval > 0) { samples.push(interval); if (samples.length > 600) samples.shift(); }
      if (stamp - lastUi >= 400) { renderUi(); lastUi = stamp; }
      if (quality === 'auto' && stamp - lastAdjust >= 5000 && samples.length > 20) {
        const recent = samples.slice(-30); const mean = recent.reduce((sum, value) => sum + value, 0) / recent.length;
        const next = mean > 36 ? Math.max(.6, ratio - .15) : mean < 18 ? Math.min(1.25, devicePixelRatio || 1, ratio + .1) : ratio;
        if (Math.abs(next - ratio) > .01) { ratio = next; resize(); }
        lastAdjust = stamp;
      }
    }
    coast.update(0); updateLayers(); updatePlay(); syncEvidence(Date.now());
    renderer.render(scene, camera);
    if (disposed) return;
    canvas.dataset.backend = 'webgl2'; canvas.dataset.source = 'synthetic';
    output.hidden = true; raf = requestAnimationFrame(loop);
  } catch (error) { dispose(); throw error; }
}

void start().catch(error => {
  output.textContent = error instanceof Error ? error.message.slice(0, 220) : 'The renderer could not initialize.';
  output.hidden = false; canvas.dataset.backend = 'unavailable';
});
