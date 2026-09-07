import './style.css';
import { createIcons, Play, Pause, SkipBack, Orbit, Move, Layers, Upload, Download, Maximize, X, ChevronRight, PanelRight, RotateCcw, Radio, Box, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Camera, Activity, Info } from 'lucide';
import { TimelineStore } from './world/timeline';
import { RuLabGraph } from './world/graph';
import { createRuLabView } from './render/view';
import { loadCaptureFiles, captureManifestFile } from './capture/manifest';
import { CaptureGraph } from './capture/graph';
import type { CaptureBundle, CapturePlaybackState } from './capture/types';
import type { EntityState, RenderMetrics, RuLabView, ScenarioId, ViewMode, Quality } from './contracts';

const base = import.meta.env.BASE_URL;
const app = document.querySelector<HTMLDivElement>('#app')!;
const icon = (name: string) => `<i data-lucide="${name}" aria-hidden="true"></i>`;
app.innerHTML = `
<main class="workspace">
  <div class="world-surface"><img id="reference" alt="RuLab architectural concept reference" src="${base}references/robotics.jpeg"><canvas id="world" aria-label="Interactive RuLab three dimensional world" tabindex="0"></canvas><div class="vignette"></div></div>
  <header class="topbar">
    <a class="brand" href="${base}" aria-label="WorldGraph home"><span class="brand-mark">${icon('box')}</span>worldgraph<span class="brand-dot">.</span><span class="brand-divider"></span><span class="brand-lab">RuLab</span></a>
    <nav class="view-tabs" aria-label="Rendering mode"><button data-mode="cinematic" aria-pressed="true">World</button><button data-mode="splats" aria-pressed="false">Gaussian</button><button data-mode="graph" aria-pressed="false">Graph</button></nav>
    <div class="top-actions"><span class="source-pill"><span></span>Authored world</span><button class="icon-button" id="graphics-open" aria-label="Graphics settings">${icon('camera')}</button><button class="icon-button" id="info" aria-label="About this world">${icon('info')}</button><button class="icon-button" id="panel-toggle" aria-label="Toggle world inspector" aria-expanded="true">${icon('panel-right')}</button></div>
  </header>
  <aside class="scene-rail" aria-label="RuLab configurations"><span class="eyebrow">ENVIRONMENTS</span><button class="scene-card active" data-scenario="robotics" aria-label="01 Robotics lab" aria-pressed="true"><img src="${base}references/robotics.jpeg" alt=""><span><b>01</b> Robotics lab</span></button><button class="scene-card" data-scenario="hospitality" aria-label="02 Hospitality lab" aria-pressed="false"><img src="${base}references/hospitality.jpeg" alt=""><span><b>02</b> Hospitality lab</span></button><button class="scene-card" data-scenario="healthcare" aria-label="03 Healthcare lab" aria-pressed="false"><img src="${base}references/healthcare.jpeg" alt=""><span><b>03</b> Healthcare lab</span></button><button class="rail-import" id="import-splat" aria-label="Open splat">${icon('upload')}<span>Open splat</span></button><input id="splat-file" type="file" accept=".ply,.splat,.spz" hidden><button class="rail-import capture-import" id="open-capture" aria-label="Open 4D capture">${icon('layers')}<span>4D capture</span></button><input id="capture-files" type="file" multiple accept=".json,.ply,.splat,.spz" hidden></aside>
  <section class="world-caption"><div class="location-line"><span class="live-dot"></span><span id="scene-kicker">RULAB / ROBOTICS</span><span class="caption-separator">/</span><span>SPACE + TIME</span></div><h1 id="scene-title">Tomorrow,<br><em>in motion.</em></h1><p id="scene-description">Explore the lab. Follow an experiment. <br>See every moment from a new perspective.</p><div class="camera-presets" aria-label="Camera positions"><button data-shot="overview" class="active">${icon('orbit')}Overview</button><button data-shot="robot">${icon('box')}Robot</button><button data-shot="drone">${icon('move')}Flight</button><button data-shot="rf">${icon('radio')}RF bay</button></div></section>
  <section id="capture-caption" class="capture-caption" hidden><div class="location-line"><span class="live-dot"></span><span>GAUSSIAN CAPTURE / SPACE + TIME</span></div><h1 id="capture-title">A scene through time.</h1><p id="capture-caption-source"></p><span class="capture-label">SHARED FRAME · REGISTRATION UNVERIFIED</span></section>
  <aside class="inspector" id="inspector" aria-label="World inspector"><div class="inspector-heading"><div><span class="eyebrow">WORLD STATE</span><h2>A living experiment</h2></div><span class="small-dot"></span></div><p id="capture-note" hidden>Local capture preview. Scale and coordinates are unverified. Choose an environment to restore the authored experiment.</p><section id="capture-details" hidden><div id="capture-frame" class="capture-frame" aria-live="polite"></div><dl class="capture-facts"><div><dt>Requested</dt><dd id="capture-requested"></dd></div><div><dt>On screen</dt><dd id="capture-displayed"></dd></div><div><dt>Declared source</dt><dd id="capture-source"></dd></div></dl><p id="capture-state" role="status"></p><button id="capture-retry" class="entity-action" hidden>Retry capture frame</button><p class="capture-integrity">SHA256 checked for each displayed sample.<br>File integrity does not verify its source.</p><code id="capture-digest"></code><button id="capture-snapshot" class="secondary-button">Export capture graph ${icon('download')}</button></section><div class="mini-map"><svg viewBox="0 0 260 140" aria-label="Top down lab map"><defs><pattern id="grid" width="13" height="13" patternUnits="userSpaceOnUse"><path d="M 13 0 L 0 0 0 13" fill="none" stroke="#ffffff0d" stroke-width=".5"/></pattern></defs><rect width="260" height="140" fill="url(#grid)"/><path d="M30 16H230V124H30Z M30 48H64V124 M196 16V62H230" fill="#73847c15" stroke="#81948b70"/><path d="M108 30H151Q157 30 157 37V106Q157 111 151 111H108Q103 111 103 105V36Q103 30 108 30Z" fill="none" stroke="#b4c9b666" stroke-dasharray="3 4"/><g id="map-entities"></g><g id="map-camera"></g></svg><span>LOCAL FRAME · METRES</span></div><div class="inspector-stats"><div><span id="entity-count">6</span><small>objects</small></div><div><span id="splat-count">···</span><small>Gaussians</small></div><div><span id="fps">···</span><small id="fps-label">FPS</small></div></div><div class="inspector-section"><div class="section-label">OBJECTS<span>SELECT TO INSPECT</span></div><div id="object-list"></div></div><section class="entity-detail" id="entity-detail" aria-live="polite"></section><div class="graph-health"><span id="graph-dot"></span><span id="graph-status">Loading Rust / WASM</span><b id="graph-count"></b></div></aside>
  <div class="render-notice" id="render-notice" role="status"><span class="spinner"></span><b>Preparing your world</b><span>Loading geometry and Gaussian renderer</span></div>
  <div class="mobile-move" aria-label="Camera movement"><button data-move="0,-1" aria-label="Move left">${icon('arrow-left')}</button><div><button data-move="1,0" aria-label="Move forward">${icon('arrow-up')}</button><button data-move="-1,0" aria-label="Move backward">${icon('arrow-down')}</button></div><button data-move="0,1" aria-label="Move right">${icon('arrow-right')}</button></div>
  <footer class="transport"><div class="transport-main"><button id="play" class="play-button" aria-label="Play experiment">${icon('play')}</button><button id="restart" class="icon-button" aria-label="Restart timeline">${icon('skip-back')}</button><div class="timecode"><b id="time">00:00.0</b><span id="duration">/ 02:00</span></div><div class="timeline-wrap"><div class="timeline-labels"><span id="timeline-title">EXPERIMENT 001</span><span id="playback-state">PAUSED</span></div><div class="timeline-track"><div id="event-markers"></div><input id="timeline" aria-label="Experiment time" type="range" min="0" max="120" value="0" step="0.05"></div><div class="timeline-ticks"><span>00:00</span><span>00:30</span><span>01:00</span><span>01:30</span><span>02:00</span></div></div><select id="speed" aria-label="Playback speed"><option value="0.25">0.25×</option><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="2">2×</option></select><button class="icon-button" id="export" aria-label="Export experiment">${icon('download')}</button><button class="icon-button" id="restore" aria-label="Import experiment">${icon('upload')}</button><input id="experiment-file" type="file" accept=".json" hidden><button class="icon-button fullscreen" id="fullscreen" aria-label="Toggle fullscreen">${icon('maximize')}</button></div><div class="transport-meta"><span><span class="key">W A S D</span> move <span class="meta-divider">·</span> Drag to look <span class="meta-divider">·</span> Scroll to zoom</span><span class="render-meta" id="render-meta">THREE.JS + SPARK</span><label>Detail <select id="quality" aria-label="Rendering detail"><option value="auto">Adaptive</option><option value="performance">Performance</option><option value="quality">Quality</option></select></label></div></footer>
  <div id="toast" class="toast" role="status" hidden></div>
  <dialog id="about"><div class="dialog-title"><span class="eyebrow">WORLDGRAPH / RULAB</span><button id="close-about" class="icon-button" aria-label="Close information">${icon('x')}</button></div><h2>A world you can<br><em>revisit.</em></h2><p>Move through a spatial RuLab scene and replay a 120 second experiment. Objects keep their identities as you change your viewpoint or rewind time.</p><dl><dt>Appearance</dt><dd>Authored architecture rendered with Gaussian primitives and conventional materials. Reference images illustrate the intended facility.</dd><dt>Motion</dt><dd>Deterministic robot, vehicle and drone animation. This demonstration does not run a learned world model or physical robot controller.</dd><dt>WorldGraph</dt><dd>The actual Rust graph runs locally through WebAssembly. Your scene and experiment imports stay on your device.</dd><dt>Bring your own capture</dt><dd>Open a Gaussian PLY, SPLAT or SPZ file up to 64 MiB and 500,000 Gaussians. Choose an environment to restore the authored scene.</dd><dt>Time-indexed captures</dt><dd>Select capture.json together with its frame files. Each sample shares one coordinate transform; the player holds the last accepted scene while loading. Sources and registration remain unverified. The included example is synthetic.</dd></dl><button id="open-capture-about" class="secondary-button">Open a 4D capture ${icon('layers')}</button><a href="https://github.com/ruvnet/worldgraph" target="_blank" rel="noopener noreferrer">Explore the source ${icon('chevron-right')}</a><button id="export-graph" class="secondary-button">Export WorldGraph snapshot ${icon('download')}</button><button id="export-metrics" class="secondary-button">Export rendering evidence ${icon('activity')}</button><div id="evidence-summary"></div></dialog>
  <dialog id="capture-picker"><div class="dialog-title"><span class="eyebrow">RULAB / CAPTURE PLAYER</span><button id="close-capture-picker" class="icon-button" aria-label="Close capture picker">${icon('x')}</button></div><h2>One space.<br><em>Every moment.</em></h2><p>Play a sequence of Gaussian scenes with an independent camera. Select <b>capture.json</b> and all its PLY, SPLAT or SPZ frames together.</p><p class="capture-picker-note">Up to 240 frames and 256 MiB total. Files stay on this device. Source claims and spatial registration remain unverified.</p><button id="capture-select" class="secondary-button">Select capture files ${icon('upload')}</button><button id="capture-example" class="secondary-button">Try synthetic 4D example ${icon('play')}</button><p class="capture-picker-note">The example is a generated Gaussian robot rig. It is not a reconstruction of the reference photographs.</p><a href="https://github.com/ruvnet/worldgraph/blob/main/docs/adr/206-rulab-capture-playback.md" target="_blank" rel="noopener noreferrer">Capture format and provenance ${icon('chevron-right')}</a></dialog>
<dialog id="graphics-dialog"><div class="dialog-title"><span class="eyebrow">RULAB / GPU GRAPHICS</span><button id="graphics-close" class="icon-button" aria-label="Close graphics settings">${icon('x')}</button></div><h2>Light. Material.<br><em>Presence.</em></h2><p>Photographic surfaces and HDR illumination. Quality adds a subtle glow and mesh reflections on the floor.</p><label class="graphics-field">Rendering quality<select id="graphics-quality" aria-label="Rendering quality"><option value="auto">Adaptive</option><option value="performance">Performance</option><option value="quality">Quality</option></select></label><label class="graphics-field">Exposure <output id="exposure-value">1.10</output><input id="exposure" aria-label="Exposure" type="range" min="0.4" max="2" step="0.05" value="1.1"></label><p id="graphics-status" role="status">Waiting for GPU capabilities.</p><p>Captures retain their original lighting. Floor reflections apply to the authored lab. Geometry remains conceptual.</p><button id="graphics-measure" class="secondary-button">Start a fresh measurement</button><button id="graphics-export" class="secondary-button">Export GPU evidence ${icon('download')}</button><p id="graphics-samples">No samples yet.</p></dialog>
</main>`;
const icons = { Play, Pause, SkipBack, Orbit, Move, Layers, Upload, Download, Maximize, X, ChevronRight, PanelRight, RotateCcw, Radio, Box, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Camera, Activity, Info };
const refreshIcons = () => createIcons({ icons, attrs: { 'stroke-width': 1.5 } });
refreshIcons();
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let timeline = new TimelineStore('robotics');
let view: RuLabView | undefined;
const graph = new RuLabGraph();
let capture: CaptureBundle | undefined;
let captureGraph: CaptureGraph | undefined;
let captureState: CapturePlaybackState | undefined;
let captureTime = 0;
let previewKind: 'authored' | 'asset' | 'capture' = 'authored';
let importBusy = false, importEpoch = 0;
let exampleAbort: AbortController | undefined;
let graphSignature = '';
let playing = false, speed = 1, selected = 'robot-1', last = performance.now(), lastSync = -1;
let metrics: RenderMetrics | undefined;
let detailSignature = '';
let lastScenario: ScenarioId = 'robotics';
const samples: number[] = [];
let toastTimer: ReturnType<typeof setTimeout>;
function notify(message: string) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 5000); }
function download(name: string, data: string | Blob) { const url = URL.createObjectURL(typeof data === 'string' ? new Blob([data], { type: 'application/json' }) : data); const a = document.createElement('a'); a.href=url; a.download=name; a.click(); setTimeout(() => URL.revokeObjectURL(url),1000); }
function formatTime(t: number) { return `${Math.floor(t/60).toString().padStart(2,'0')}:${(t%60).toFixed(1).padStart(4,'0')}`; }
function currentTime() { return capture ? captureTime : timeline.getFrame().time; }
function duration() { return capture?.manifest.duration ?? 120; }
function setPlaying(value: boolean) {
  playing = value;
  $('play').innerHTML = icon(playing ? 'pause' : 'play');
  $('play').setAttribute('aria-label', `${playing ? 'Pause' : 'Play'} ${capture ? 'capture' : 'experiment'}`);
  $('playback-state').textContent = playing ? 'PLAYING' : 'PAUSED';
  refreshIcons();
}
function setCapturePreview(value: boolean) {
  samples.length=0;
  previewKind = value ? capture ? 'capture' : 'asset' : 'authored';
  const workspace = document.querySelector<HTMLElement>('.workspace')!;
  workspace.classList.toggle('capture-preview', value);
  workspace.classList.toggle('temporal-capture', previewKind === 'capture');
  workspace.dataset.worldKind = previewKind;
  document.querySelector('.source-pill')!.textContent = capture ? 'Time-indexed capture' : value ? 'Local capture preview' : 'Authored world';
  $('capture-note').hidden = !value;
  $('capture-note').textContent = capture ? 'Appearance samples share one frame. Source claims and registration to the lab are unverified.' : 'Local capture preview. Scale and coordinates are unverified. Choose an environment to restore the authored experiment.';
  document.querySelector('.inspector h2')!.textContent = capture ? 'Capture state' : value ? 'Unaligned capture' : 'A living experiment';
  $('capture-details').hidden = !capture;
  $('capture-caption').hidden = !capture;
  $<HTMLButtonElement>('export').setAttribute('aria-label', capture ? 'Export capture manifest' : 'Export experiment');
  $<HTMLButtonElement>('export-graph').disabled = previewKind === 'asset';
  const graphMode = document.querySelector<HTMLButtonElement>('[data-mode="graph"]')!;
  graphMode.disabled = value;
  graphMode.title = value ? 'Unregistered appearance has no authored scene links. Export capture metadata from the inspector.' : '';
  if (value && graphMode.getAttribute('aria-pressed') === 'true') {
    view?.setMode('splats');
    document.querySelectorAll<HTMLElement>('[data-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.mode === 'splats')));
  }
  if (value) document.querySelectorAll<HTMLElement>('[data-scenario]').forEach(button => { button.classList.remove('active'); button.setAttribute('aria-pressed', 'false'); });
  else syncScenarioUI(true);
  if (capture) {
    $('capture-title').textContent = capture.manifest.name;
    $('capture-caption-source').textContent = `${capture.manifest.frames.length} time-indexed samples · ${capture.manifest.source} source declaration`;
    $('capture-source').textContent = capture.manifest.source;
    $('capture-digest').textContent = `Manifest ${capture.manifestSha256.slice(0,16)}…`;
    $('capture-digest').title = capture.manifestSha256;
  }
  const slider = $<HTMLInputElement>('timeline');
  slider.max = String(duration()); slider.setAttribute('aria-label', capture ? 'Capture time' : 'Experiment time');
  $('duration').textContent = `/ ${formatTime(duration()).slice(0,5)}`;
  $('timeline-title').textContent = capture ? 'CAPTURE PLAYBACK' : 'EXPERIMENT 001';
  document.querySelectorAll<HTMLElement>('.timeline-ticks span').forEach((tick,i) => tick.textContent = formatTime(duration()*i/4).slice(0,5));
  graphSignature = ''; lastSync = -1; samples.length = 0;
  $('world').dataset.frameSamples = '0'; $('evidence-summary').textContent = '0 rendering samples collected for this scene.';
  $<HTMLButtonElement>('play').disabled = false;
  setPlaying(false);
}
function clearCapture() {
  captureGraph?.dispose(); captureGraph = undefined; capture = undefined; captureState = undefined; captureTime = 0;
}
function cancelImports() { importEpoch++; exampleAbort?.abort(); exampleAbort = undefined; }
function seekTime(time: number) {
  if (capture) { captureTime = Math.min(duration(), Math.max(0,time)); view?.seekCapture(captureTime); }
  else timeline.seek(time);
  lastSync = -1; renderUI();
}
function syncActiveGraph() {
  try {
    if (capture && captureState && captureGraph) {
      const signature = JSON.stringify([capture.manifestSha256,captureState]);
      if (signature !== graphSignature) { captureGraph.sync(capture,captureState); graphSignature = signature; }
      $('graph-count').textContent = String(captureGraph.nodeCount());
      $('graph-count').dataset.time = String(captureState.requestedTime);
      $('graph-count').dataset.world = 'capture';
      $('graph-status').textContent = 'Rust capture graph · WebAssembly';
    } else {
      graph.sync(timeline.getFrame());
      $('graph-count').textContent = String(graph.nodeCount());
      $('graph-count').dataset.time = String(timeline.getFrame().time);
      $('graph-count').dataset.world = 'authored';
      $('graph-status').textContent = 'Rust graph · WebAssembly';
    }
    $('graph-dot').classList.add('ready'); $('graph-dot').classList.remove('error');
    lastSync = currentTime();
  } catch {
    const unavailable = capture ? captureGraph?.status === 'unavailable' : graph.status === 'unavailable';
    if (unavailable) { $('graph-status').textContent = 'Rust graph update failed'; $('graph-dot').classList.remove('ready'); $('graph-dot').classList.add('error'); }
  }
}
function renderCaptureState() {
  if (!capture || !captureState) return;
  const state = captureState;
  $('capture-frame').textContent = state.displayedIndex === null ? 'No accepted sample' : `Frame ${state.displayedIndex+1} of ${capture.manifest.frames.length}`;
  $('capture-frame').dataset.index = String(state.displayedIndex ?? -1);
  $('capture-frame').dataset.loading = String(state.loading);
  $('capture-frame').dataset.displayedTime = String(state.displayedTime ?? '');
  $('capture-requested').textContent = formatTime(state.requestedTime);
  $('capture-displayed').textContent = state.displayedTime === null ? 'Waiting' : formatTime(state.displayedTime);
  $('capture-state').textContent = state.error ?? (state.loading ? 'Loading requested sample. The last accepted scene stays visible.' : 'Showing the accepted sample at or before the requested time.');
  $('capture-state').classList.toggle('capture-error', Boolean(state.error));
  $('capture-retry').hidden = !state.error;
  $<HTMLButtonElement>('play').disabled = Boolean(state.error);
}
function onCaptureState(state: CapturePlaybackState, bundle: CaptureBundle) {
  if (bundle !== capture) return;
  captureState = state;
  if (state.error) setPlaying(false);
  renderCaptureState(); lastSync = -1;
}
function exportActiveGraph() {
  try {
    if (capture && captureState && captureGraph) { captureGraph.sync(capture,captureState); download('rulab-capture-worldgraph.json',captureGraph.exportJson()); }
    else { graph.sync(timeline.getFrame()); download('rulab-worldgraph.json',graph.exportJson()); }
  } catch { notify('The Rust graph is not ready. Reload and check WebAssembly support.'); }
}
async function withImport(operation: (epoch: number) => Promise<void>, needsGpu = true) {
  if (importBusy) { notify('Wait for the current import to finish.'); return; }
  if (needsGpu && (!view || metrics?.backend !== 'webgl2')) { notify('Opening Gaussian scenes requires WebGL2 on this device.'); return; }
  importBusy = true; const epoch = ++importEpoch; setPlaying(false);
  try { await operation(epoch); }
  catch (error) { if (epoch === importEpoch) notify(error instanceof Error ? error.message : 'Import could not be completed.'); }
  finally { importBusy = false; }
}
async function activateCapture(files: readonly File[], epoch: number) {
  const bundle = await loadCaptureFiles(files);
  if (epoch !== importEpoch) return;
  const nextGraph = new CaptureGraph(); let adopted = false;
  try {
    await nextGraph.initialize();
    if (epoch !== importEpoch) return;
    const state = await view!.loadCapture(bundle);
    if (epoch !== importEpoch) return;
    clearCapture(); capture = bundle; captureGraph = nextGraph; captureState = state; captureTime = state.requestedTime; adopted = true;
    setCapturePreview(true); syncActiveGraph(); renderUI();
    notify('4D sequence opened. Source claims and spatial registration remain unverified.');
  } finally { if (!adopted) nextGraph.dispose(); }
}
async function loadExample(epoch: number) {
  exampleAbort = new AbortController();
  // A fixed, same-origin sample. Local manifests never trigger remote requests.
  const names = ['capture.json','frame-000.splat','frame-001.splat','frame-002.splat','frame-003.splat'];
  const files: File[] = [];
  for (const name of names) {
    const response = await fetch(`${base}capture-example/${name}`, {signal: exampleAbort.signal});
    if (!response.ok) throw new Error(`Example file could not load: ${name}`);
    if (!response.body) throw new Error('Example response has no readable body.');
    const reader = response.body.getReader(); const chunks: Uint8Array<ArrayBuffer>[] = []; let size = 0;
    try {
      for (;;) {
        const {value,done} = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > 1024*1024) { await reader.cancel(); throw new Error('Example file exceeds its 1 MiB bound.'); }
        chunks.push(new Uint8Array(value));
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.byteLength; }
    if (epoch !== importEpoch) return;
    files.push(new File([bytes],name,{type:name.endsWith('.json')?'application/json':'application/octet-stream'}));
  }
  await activateCapture(files,epoch);
}

function selectEntity(id: string) { selected=id; renderUI(); }
function actionButton(text: string, fn: () => void) { const b=document.createElement('button'); b.className='entity-action'; b.textContent=text; b.onclick=()=>{try{fn();}catch(error){notify(error instanceof Error?error.message:'Action could not be recorded.');}}; return b; }
function renderUI() {
  syncScenarioUI();
  const frame=timeline.getFrame();
  const time=currentTime();
  $('time').textContent=formatTime(time); ($<HTMLInputElement>('timeline')).value=String(time);
  $('timeline').style.setProperty('--progress',`${time/duration()*100}%`);
  if(capture){renderCaptureState();const markers=$('event-markers');if(markers.dataset.capture!==capture.manifestSha256){markers.replaceChildren();for(const sample of capture.manifest.frames){const marker=document.createElement('span');marker.style.left=`${sample.time/duration()*100}%`;marker.title=`Sample at ${formatTime(sample.time)}`;markers.append(marker);}markers.dataset.capture=capture.manifestSha256;}return;}
  $('entity-count').textContent=String(frame.entities.length);
  const detailKey = JSON.stringify([selected, frame.scenario, frame.events, frame.entities.find(e=>e.id==='rf-door')!.joints[0] > 0.5]);
  if (detailKey !== detailSignature) {
  detailSignature = detailKey;
  const list=$('object-list'); list.replaceChildren();
  for(const e of frame.entities) { const button=document.createElement('button'); button.className=`object-row ${e.id===selected?'selected':''}`; button.dataset.entity=e.id; const dot=document.createElement('span'); dot.className=`object-dot ${e.kind}`; const name=document.createElement('span'); name.textContent=e.label; const state=document.createElement('small'); state.textContent=e.kind==='sensor'?'READY':e.kind==='door'?(e.joints[0]>0.5?'OPEN':'CLOSED'):'AUTHORED'; button.append(dot,name,state); button.onclick=()=>selectEntity(e.id); list.append(button); }
  const entity=frame.entities.find(e=>e.id===selected);
  const detail=$('entity-detail'); detail.replaceChildren();
  if(entity) {
    const title=document.createElement('div'); title.className='section-label'; title.textContent=entity.label; detail.append(title);
    const coordinates=document.createElement('div'); coordinates.className='coordinates'; coordinates.textContent=entity.position.map((v,i)=>`${['E','N','U'][i]} ${v.toFixed(2)} m`).join('   '); detail.append(coordinates);
    const provenance=document.createElement('p'); provenance.textContent=`${entity.source} · ${entity.id} · ENU frame`; detail.append(provenance);
    if(entity.kind==='door') { const commands=frame.events.filter(e=>e.kind==='door'&&e.entityId===entity.id);const requestedOpen=commands.length?commands[commands.length-1].value:false;detail.append(actionButton(requestedOpen?'Close RF door':'Open RF door',()=>{timeline.record({kind:'door',entityId:entity.id,value:!requestedOpen}); lastSync=-1;renderUI();})); }
    if(['robot','amr','drone'].includes(entity.kind)) { const events=frame.events.filter(e=>e.kind==='pause-agent'&&e.entityId===entity.id&&e.time<=frame.time); const paused=events.length?events[events.length-1].value:false; detail.append(actionButton(paused?'Resume this agent':'Pause this agent',()=>{timeline.record({kind:'pause-agent',entityId:entity.id,value:!paused});lastSync=-1;renderUI();})); }
  }
  }
  const activeEntity = frame.entities.find(e=>e.id===selected);
  const coords = $('entity-detail').querySelector('.coordinates');
  if (activeEntity && coords) coords.textContent = activeEntity.position.map((v,i)=>`${['E','N','U'][i]} ${v.toFixed(2)} m`).join('   ');
  const markers=$('event-markers');delete markers.dataset.capture;markers.replaceChildren(); for(const e of frame.events) { const marker=document.createElement('span');marker.style.left=`${e.time/120*100}%`;marker.title=`${e.kind} at ${formatTime(e.time)}`;markers.append(marker); }
  const svgNS='http://www.w3.org/2000/svg';const group=$('map-entities');group.replaceChildren();
  for(const e of frame.entities) { const circle=document.createElementNS(svgNS,'circle');circle.setAttribute('cx',String(130+e.position[0]*8));circle.setAttribute('cy',String(70-e.position[1]*3));circle.setAttribute('r',e.id===selected?'5':'3');circle.setAttribute('fill',e.kind==='drone'?'#e8b581':e.kind==='sensor'?'#8bbbd8':'#c7dbbe');group.append(circle); }
}
const descriptions:Record<ScenarioId,[string,string,string]>={robotics:['RULAB / ROBOTICS','Tomorrow,<br><em>in motion.</em>','Explore the lab. Follow an experiment. <br>See every moment from a new perspective.'],hospitality:['RULAB / HOSPITALITY','Spaces that<br><em>understand.</em>','Explore service robotics and modular rooms. <br>Replay an experiment on your own terms.'],healthcare:['RULAB / HEALTHCARE','Designed<br><em>around care.</em>','Explore an authored care environment. <br>Follow assistance robots through space and time.']};
document.querySelectorAll<HTMLButtonElement>('[data-scenario]').forEach(b=>b.onclick=()=>{cancelImports();clearCapture();timeline.setScenario(b.dataset.scenario as ScenarioId);setPlaying(false);selected='robot-1';lastSync=-1;view?.reset();setCapturePreview(false);renderUI();});
document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(b=>b.onclick=()=>{view?.setMode(b.dataset.mode as ViewMode);document.querySelectorAll<HTMLElement>('[data-mode]').forEach(c=>c.setAttribute('aria-pressed',String(c===b)));});
document.querySelectorAll<HTMLButtonElement>('[data-shot]').forEach(b=>b.onclick=()=>{view?.cameraPreset(b.dataset.shot as 'overview'|'robot'|'drone'|'rf');document.querySelectorAll<HTMLElement>('[data-shot]').forEach(c=>c.classList.toggle('active',c===b));if(b.dataset.shot==='rf')selectEntity('rf-door');else if(b.dataset.shot==='robot')selectEntity('robot-1');else if(b.dataset.shot==='drone')selectEntity('drone-1');});
$('play').onclick=()=>{if(currentTime()>=duration())seekTime(0);setPlaying(!playing);};
$('restart').onclick=()=>seekTime(0);
$('timeline').oninput=()=>{setPlaying(false);seekTime(Number($<HTMLInputElement>('timeline').value));};
$('speed').onchange=()=>speed=Number($<HTMLSelectElement>('speed').value);
function setQuality(value:Quality){samples.length=0;$<HTMLSelectElement>('quality').value=value;$<HTMLSelectElement>('graphics-quality').value=value;view?.setQuality(value);}
$('quality').onchange=()=>setQuality($<HTMLSelectElement>('quality').value as Quality);
$('graphics-quality').onchange=()=>setQuality($<HTMLSelectElement>('graphics-quality').value as Quality);
$('graphics-open').onclick=()=>$<HTMLDialogElement>('graphics-dialog').showModal();
$('graphics-close').onclick=()=>$<HTMLDialogElement>('graphics-dialog').close();
$('exposure').oninput=()=>{const value=Number($<HTMLInputElement>('exposure').value);samples.length=0;$('exposure-value').textContent=value.toFixed(2);view?.setExposure(value);};
$('graphics-measure').onclick=()=>{samples.length=0;view?.setQuality($<HTMLSelectElement>('quality').value as Quality);notify('New measurement started. Close this panel and navigate before exporting.');};
$('graphics-export').onclick=()=>$('export-metrics').click();
$('export').onclick=()=>capture?download('capture.json',captureManifestFile(capture)):download('rulab-experiment.json',timeline.exportJson());
$('restore').onclick=()=>$<HTMLInputElement>('experiment-file').click();
$('experiment-file').onchange=async()=>{
  const input=$<HTMLInputElement>('experiment-file'); const file=input.files?.[0]; input.value=''; if(!file)return;
  await withImport(async epoch=>{
    if(file.size>1024*1024)throw new Error('Experiment files must be under 1 MB.');
    const next=TimelineStore.fromJson(await file.text());
    if(epoch!==importEpoch||disposed)return;
    clearCapture(); timeline=next; setPlaying(false); lastSync=-1; view?.reset(); setCapturePreview(false); renderUI();
    notify('Experiment restored. Changes remain on this device.');
  },false);
};
$('import-splat').onclick=()=>$<HTMLInputElement>('splat-file').click();
$('splat-file').onchange=async()=>{const input=$<HTMLInputElement>('splat-file');const file=input.files?.[0];input.value='';if(!file)return;await withImport(async epoch=>{notify('Opening your Gaussian scene…');await view!.loadSplat(file);if(epoch!==importEpoch)return;clearCapture();setCapturePreview(true);renderUI();notify('Local scene preview loaded. Its coordinates are unverified; choose an environment to restore the authored experiment.');});};
function openCapturePicker() { $<HTMLDialogElement>('about').close(); $<HTMLDialogElement>('capture-picker').showModal(); }
$('open-capture').onclick=openCapturePicker;
$('open-capture-about').onclick=openCapturePicker;
$('close-capture-picker').onclick=()=>$<HTMLDialogElement>('capture-picker').close();
$('capture-select').onclick=()=>$<HTMLInputElement>('capture-files').click();
$('capture-files').onchange=async()=>{const input=$<HTMLInputElement>('capture-files');const files=Array.from(input.files??[]);input.value='';if(!files.length)return;$<HTMLDialogElement>('capture-picker').close();await withImport(async epoch=>{notify('Checking capture manifest and first sample…');await activateCapture(files,epoch);});};
$('capture-example').onclick=async()=>{$<HTMLDialogElement>('capture-picker').close();await withImport(async epoch=>{notify('Opening the synthetic Gaussian example…');await loadExample(epoch);});};
$('capture-retry').onclick=()=>view?.retryCapture();
$('capture-snapshot').onclick=exportActiveGraph;
$('panel-toggle').onclick=()=>{const open=!$('inspector').classList.contains('is-open');$('inspector').classList.toggle('is-open',open);$('panel-toggle').setAttribute('aria-expanded',String(open));};
const media=matchMedia('(min-width: 1000px)');$('inspector').classList.toggle('is-open',media.matches);$('panel-toggle').setAttribute('aria-expanded',String(media.matches));
$('info').onclick=()=>$<HTMLDialogElement>('about').showModal();$('close-about').onclick=()=>$<HTMLDialogElement>('about').close();
$('fullscreen').onclick=async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen();}catch{notify('Fullscreen is unavailable in this browser.');}};
$('export-graph').onclick=exportActiveGraph;
$('export-metrics').onclick=()=>{const sorted=[...samples].sort((a,b)=>a-b);const report={schema:'worldgraph.rulab.render-evidence.v1',timestamp:new Date().toISOString(),backend:metrics?.backend??'unavailable',userAgent:navigator.userAgent,viewport:[innerWidth,innerHeight],devicePixelRatio,frameSamples:samples.length,p50FrameMs:sorted.length?sorted[Math.floor(sorted.length*.5)]:null,p95FrameMs:sorted.length?sorted[Math.min(sorted.length-1,Math.floor(sorted.length*.95))]:null,metrics,worldKind:previewKind,capture:capture?{manifestSha256:capture.manifestSha256,declaredSource:capture.manifest.source,state:captureState,registration:'unverified'}:null,limitations:['Device rendering measurement only; not reconstruction accuracy or model inference.',capture?'Time-indexed appearance playback; source declarations and registration unverified.':previewKind==='asset'?'Local appearance preview; source and registration unverified.':'Authored scene and deterministic kinematics.']};download('rulab-render-evidence.json',JSON.stringify(report,null,2));};
let moveTimer:ReturnType<typeof setInterval>|undefined;
const stopMove=()=>{if(moveTimer)clearInterval(moveTimer);moveTimer=undefined;};
document.querySelectorAll<HTMLButtonElement>('[data-move]').forEach(b=>{b.onpointerdown=e=>{e.preventDefault();stopMove();b.setPointerCapture(e.pointerId);const [f,r]=b.dataset.move!.split(',').map(Number);view?.move(f*.3,r*.3);moveTimer=setInterval(()=>view?.move(f*.15,r*.15),40);};b.onpointerup=stopMove;b.onpointercancel=stopMove;b.onlostpointercapture=stopMove;});
window.addEventListener('blur',()=>{setPlaying(false);stopMove();});
document.addEventListener('visibilitychange',()=>{if(document.hidden){setPlaying(false);stopMove();}last=performance.now();});
let graphicsSignature='';
function onMetrics(m:RenderMetrics){const signature=JSON.stringify(m.graphics);if(signature!==graphicsSignature){samples.length=0;graphicsSignature=signature;}metrics=m;if(!m.graphics&&m.backend==='unavailable'){$('graphics-status').textContent='GPU rendering is unavailable on this device. Reference view remains active.';$<HTMLSelectElement>('graphics-quality').disabled=true;$<HTMLSelectElement>('quality').disabled=true;$<HTMLButtonElement>('graphics-measure').disabled=true;$<HTMLInputElement>('exposure').disabled=true;}if(m.graphics){const g=m.graphics;$('world').dataset.graphics=JSON.stringify(g);$('graphics-status').textContent=`${g.hdr?'HDR supported':'Standard output'} · ${g.photographicMaps}/6 photographic maps · ${g.environment} · ${g.pixelRatio.toFixed(2)}× resolution · reflections ${g.reflections?'on':'off'}`;}$('graphics-samples').textContent=`${samples.length} samples in this configuration. Physical GPU performance requires testing on your device.`;$('world').dataset.backend=m.backend;$('world').dataset.splats=String(m.splatCount);$('world').dataset.camera=JSON.stringify(m.camera);$('world').dataset.drawCalls=String(m.drawCalls);$('world').dataset.status=m.status;$('fps').textContent=m.backend==='webgl2'?String(Math.round(m.fps)):'···';$('fps-label').textContent=m.backend==='webgl2'?'FPS':'NO GPU';$('splat-count').textContent=m.splatCount>=1000?`${(m.splatCount/1000).toFixed(1)}k`:String(m.splatCount);$('render-meta').textContent=m.backend==='webgl2'?`SPARK · ${m.frameMs.toFixed(1)} MS · ${m.drawCalls} DRAWS`:'REFERENCE VIEW · WEBGL2 REQUIRED';if(m.backend==='webgl2'&&m.frameTimesMs){samples.push(...m.frameTimesMs.filter(x=>Number.isFinite(x)&&x>0));if(samples.length>3600)samples.splice(0,samples.length-3600);}if(m.backend==='webgl2'){$('render-notice').hidden=true;$('reference').classList.add('rendered');}else{setPlaying(false);$('reference').classList.remove('rendered');$('render-notice').hidden=false;$('render-notice').innerHTML='<b>3D rendering needs WebGL2</b><span>This is a reference image. Timeline and WorldGraph remain available.</span>';const reason=document.createElement('small');reason.textContent=m.status;$('render-notice').append(reason);$('render-notice').classList.add('unavailable');}$('world').dataset.frameSamples=String(samples.length);$('evidence-summary').textContent=`${samples.length} rendering samples collected on this device.`;}
renderUI();
createRuLabView({canvas:$<HTMLCanvasElement>('world'),onSelect:selectEntity,onMetrics,onCaptureState}).then(v=>{view=v;v.setQuality($<HTMLSelectElement>('quality').value as Quality);v.setExposure(Number($<HTMLInputElement>('exposure').value));v.setFrame(timeline.getFrame());}).catch(e=>{onMetrics({backend:'unavailable',fps:0,frameMs:0,splatCount:0,drawCalls:0,camera:[0,0,0],status:'Renderer unavailable'});notify(e instanceof Error?e.message:'WebGL2 renderer unavailable.');});
graph.initialize().then(()=>{$('graph-dot').classList.add('ready');$('graph-status').textContent='Rust graph · WebAssembly';lastSync=-1;}).catch(()=>{$('graph-status').textContent='Rust graph unavailable';$('graph-dot').classList.add('error');});
function syncScenarioUI(force=false){const id=timeline.getFrame().scenario;if(id===lastScenario&&!force)return;lastScenario=id;const d=descriptions[id];$('scene-kicker').textContent=d[0];$('scene-title').innerHTML=d[1];$('scene-description').innerHTML=d[2];$<HTMLImageElement>('reference').src=`${base}references/${id}.jpeg`;document.querySelectorAll<HTMLElement>('[data-scenario]').forEach(c=>{const active=c.dataset.scenario===id;c.classList.toggle('active',active);c.setAttribute('aria-pressed',String(active));});}
let renderAccumulator=0, animationId=0, disposed=false;
function tick(now:number){
  if(disposed)return;
  const dt=Math.min((now-last)/1000,.1);last=now;
  if(playing){const time=Math.min(duration(),currentTime()+dt*speed);if(capture){captureTime=time;view?.seekCapture(time);}else timeline.seek(time);if(time>=duration())setPlaying(false);}
  const frame=timeline.getFrame();syncScenarioUI();view?.setFrame(frame);
  renderAccumulator+=dt;
  if(renderAccumulator>=.15){renderUI();renderAccumulator=0;}
  if(Math.abs(currentTime()-lastSync)>.1||lastSync<0)syncActiveGraph();
  animationId=requestAnimationFrame(tick);
}
animationId=requestAnimationFrame(tick);
window.addEventListener('pagehide',(event)=>{stopMove();setPlaying(false);if(event.persisted)return;disposed=true;cancelImports();cancelAnimationFrame(animationId);clearTimeout(toastTimer);view?.dispose();graph.dispose();captureGraph?.dispose();});
window.addEventListener('pageshow',()=>{last=performance.now();});
