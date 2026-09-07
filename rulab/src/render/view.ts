import * as T from 'three';
import {makeCinema} from './cinema';
import {graphicsProfile,adaptiveRatio,clampExposure,budgetPixelRatio} from './quality';
import {loadPhotographicAssets} from './photographic';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import type { ViewOptions, RuLabView, RenderMetrics, WorldFrame, ViewMode, Quality } from '../contracts';
import { makeArchitecture, disposeGroup } from './architecture';
import { makeEntities } from './objects';
import { makeControls, type Position3 } from './controls';
import { preflightSplat, MAX_IMPORT_SPLATS } from './imports';
import type { CaptureBundle, CaptureManifest, CapturePlaybackState } from '../capture/types';
import { CapturePlayback, capturePreviewTransform } from '../capture/playback';
import { assertCaptureBundle, loadCaptureFrame, selectCaptureFrame } from '../capture/manifest';

const PRESETS:Record<'overview'|'robot'|'drone'|'rf',{position:Position3;target:Position3}>={
  overview:{position:[3.2,2.45,10],target:[0,2,-4]}, robot:{position:[3.7,2.8,3.1],target:[0,1.9,-2]},
  drone:{position:[4.8,5.7,5.4],target:[0,4.8,0]}, rf:{position:[3.8,2.3,1.9],target:[9,2,-3]},
};
function unavailable(options:ViewOptions,status:string):RuLabView{
  options.onMetrics({backend:'unavailable',fps:0,frameMs:0,splatCount:0,drawCalls:0,camera:[3.2,-10,2.45],status});
  return {setFrame(){},setMode(){},setQuality(){},setExposure(){},cameraPreset(){},move(){},reset(){},async loadSplat(){throw new Error('Gaussian rendering requires WebGL2. Try a browser with GPU access.');},async loadCapture(){throw new Error('Capture playback requires WebGL2.');},seekCapture(){},retryCapture(){},dispose(){}};
}
/** Actual perspective geometry, anisotropic Gaussians, state-driven motion. */
export async function createRuLabView(options:ViewOptions):Promise<RuLabView>{
  const {canvas}=options;let gl:WebGL2RenderingContext|null;
  try{gl=canvas.getContext('webgl2',{alpha:false,antialias:false,powerPreference:'high-performance'});}catch{gl=null;}
  if(!gl)return unavailable(options,'WebGL2 is unavailable. Reference image mode does not render 3D.');
  let renderer:T.WebGLRenderer;
  try{renderer=new T.WebGLRenderer({canvas,context:gl,antialias:false,powerPreference:'high-performance'});}catch{return unavailable(options,'The GPU renderer could not initialize.');}
  const startupCleanup:Array<()=>void>=[()=>{renderer.dispose();renderer.forceContextLoss();}];
  try {
  let startupShaderFailed=false;renderer.debug.onShaderError=()=>{startupShaderFailed=true;};
  renderer.outputColorSpace=T.SRGBColorSpace;renderer.toneMapping=T.ACESFilmicToneMapping;renderer.toneMappingExposure=1.1;
  renderer.shadowMap.enabled=true;renderer.shadowMap.type=T.PCFSoftShadowMap;
  const scene=new T.Scene();scene.fog=new T.FogExp2(0x777b7b,.014);
  const camera=new T.PerspectiveCamera(64,1,.065,250);
  const spark=new SparkRenderer({renderer,maxStdDev:Math.sqrt(7),minSortIntervalMs:20,lodSplatCount:500_000,maxPagedSplats:65536*8});startupCleanup.push(()=>spark.dispose());scene.add(spark);
  const architecture=makeArchitecture();startupCleanup.push(()=>architecture.dispose());const entities=makeEntities();startupCleanup.push(()=>entities.dispose());scene.add(architecture.meshes,architecture.splats,entities.root);
  await architecture.splats.initialized;
  const atmosphere=makeAtmosphere();startupCleanup.push(()=>disposeGroup(atmosphere));scene.add(atmosphere);
  scene.add(new T.HemisphereLight(0xdce8ee,0x725133,1.15));
  const sun=new T.DirectionalLight(0xffe2b8,2.4);sun.position.set(-9,15,-20);sun.target.position.set(0,0,1);scene.add(sun,sun.target);sun.castShadow=true;
  sun.shadow.mapSize.set(1024,1024);sun.shadow.camera.left=-22;sun.shadow.camera.right=22;sun.shadow.camera.top=24;sun.shadow.camera.bottom=-24;sun.shadow.camera.near=.1;sun.shadow.camera.far=65;sun.shadow.bias=-.00045;sun.shadow.normalBias=.055;
  for(const z of [-11,0,11]){const fill=new T.PointLight(0xffc888,55,20,2);fill.position.set(-4,5,z);scene.add(fill);}
  const rfLight=new T.PointLight(0xd3e2f2,26,8,2);rfLight.position.set(9.4,3.6,-3);scene.add(rfLight);
  const environmentRoom=new RoomEnvironment();const pmrem=new T.PMREMGenerator(renderer);const environment=pmrem.fromScene(environmentRoom,.08);startupCleanup.push(()=>environment.dispose());scene.environment=environment.texture;scene.environmentIntensity=.62;environmentRoom.dispose();pmrem.dispose();if(startupShaderFailed)throw new Error('GPU environment shader initialization failed.');
  const debugRenderer=gl.getExtension('WEBGL_debug_renderer_info');
  const gpuRenderer=String(debugRenderer?gl.getParameter(debugRenderer.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER)).slice(0,256);
  renderer.info.autoReset=false;
  const reflectionExcluded:T.Object3D[]=[spark,architecture.splats];entities.root.traverse(o=>{if(o instanceof SplatMesh)reflectionExcluded.push(o);});
  const cinema=makeCinema(renderer,scene,camera,reflectionExcluded);startupCleanup.push(()=>cinema.dispose());
  let photographic:Awaited<ReturnType<typeof loadPhotographicAssets>>|undefined;
  const raycaster=new T.Raycaster();let disposed=false,failed=false,importGeneration=0,loading=false;
  let capture:CapturePlayback<SplatMesh>|null=null,pendingCapture:CapturePlayback<SplatMesh>|null=null,captureBundle:CaptureBundle|null=null;
  let singleImportAbort:AbortController|null=null;let decodeTail:Promise<void>=Promise.resolve();
  let imported:SplatMesh|undefined,mode:ViewMode='cinematic',quality:Quality='auto',lastFrame:WorldFrame|undefined;
  let effectiveRatio=1;let importName='';let ratio=graphicsProfile('auto',window.devicePixelRatio,cinema.hdr).pixelRatio;let raf=0,lastTime=0,windowStart=0,frames=0,elapsedMs=0,lastAdjustment=0;let frameSamples:number[]=[];
  const controls=makeControls(canvas,camera,(x,y)=>{if(disposed||failed||imported||capture)return;const r=canvas.getBoundingClientRect();raycaster.setFromCamera(new T.Vector2((x-r.left)/r.width*2-1,-((y-r.top)/r.height)*2+1),camera);
    const hits=raycaster.intersectObjects(entities.pickables,true);for(const hit of hits){let object:T.Object3D|null=hit.object;while(object){if(typeof object.userData.entityId==='string'){options.onSelect(object.userData.entityId);return;}object=object.parent;}}
  });
  startupCleanup.push(()=>controls.dispose());controls.lookAt(PRESETS.overview.position,PRESETS.overview.target);
  function status(){if(capture&&captureBundle){const state=capture.getState();return `${captureBundle.manifest.source} capture: ${captureBundle.manifest.name}. Requested ${state.requestedTime.toFixed(2)}s; displayed ${state.displayedTime?.toFixed(2)??'none'}s.${state.error?' Frame failed; last good sample held.':state.loading?' Loading sample.':''} Fixed preview transform; registration unverified.`;}return importName?`Local asset: ${importName}. Preview normalized; coordinates and provenance unverified.`:'Authored RuLab. Gaussian surfaces and mesh objects. Scripted replay.';}
  function metrics(fps:number,frameMs:number):RenderMetrics{return {graphics:{quality,mode,gpuRenderer,drawingBuffer:[canvas.width,canvas.height],pixelRatio:effectiveRatio,exposure:renderer.toneMappingExposure,hdr:cinema.hdr,reflections:cinema.reflectionEnabled,photographicMaps:photographic?.materialMaps??0,environment:photographic?.hdri?'photographic HDR':'generated room'},backend:failed?'unavailable':'webgl2',fps,frameMs,frameTimesMs:[...frameSamples],splatCount:capture?.displayedAsset?.numSplats??imported?.numSplats??(architecture.splats.numSplats+entities.splatCount),drawCalls:renderer.info.render.calls,camera:[camera.position.x,-camera.position.z,camera.position.y],status:status()};}
  function applyMode(){const external=Boolean(imported||capture);entities.root.visible=!external;controls.setCollisionEnabled(!external);architecture.meshes.visible=!external&&mode!=='splats';architecture.splats.visible=!external&&mode!=='cinematic';architecture.splats.opacity=mode==='graph'?.16:.96;cinema.setAuthored(!external&&mode==='cinematic');entities.setGraph(!external&&mode==='graph');atmosphere.visible=!external;scene.background=external?new T.Color(0x141c1e):null;scene.fog=external||mode==='splats'?null:new T.FogExp2(0x777b7b,.014);}
  function resize(){if(disposed)return;const r=canvas.getBoundingClientRect();const w=Math.max(1,Math.round(r.width)),h=Math.max(1,Math.round(r.height));effectiveRatio=budgetPixelRatio(ratio,w,h,quality);renderer.setPixelRatio(effectiveRatio);renderer.setSize(w,h,false);cinema.resize(w,h,effectiveRatio);camera.aspect=w/h;camera.updateProjectionMatrix();}
  const observer=new ResizeObserver(resize);startupCleanup.push(()=>observer.disconnect());observer.observe(canvas);resize();applyMode();cinema.configure(graphicsProfile(quality,window.devicePixelRatio,cinema.hdr));
  void loadPhotographicAssets(renderer,architecture.meshes,scene,()=>disposed).then(value=>{photographic=value;if(!disposed)options.onMetrics(metrics(0,0));});
  function contextLost(e:Event){e.preventDefault();failRenderer('GPU context lost. Reload to restore the 3D renderer.');}
  canvas.addEventListener('webglcontextlost',contextLost);
  renderer.debug.onShaderError=()=>{if(!failed)failRenderer('A required GPU shader could not compile. Reference image mode is active.');};
  function loop(time:number){if(disposed||failed)return;raf=requestAnimationFrame(loop);if(document.hidden){lastTime=0;windowStart=time;frames=0;elapsedMs=0;frameSamples=[];return;}const dt=lastTime?(time-lastTime)/1000:1/60;lastTime=time;controls.update(dt);
    try{cinema.render();}catch(error){failRenderer(`GPU rendering failed: ${boundedError(error)}`);return;}
    if(failed)return;frames++;elapsedMs+=dt*1000;frameSamples.push(dt*1000);if(!windowStart)windowStart=time;
    if(time-windowStart>=750){const frameMs=elapsedMs/frames;const fps=1000/frameMs;options.onMetrics(metrics(Math.round(fps),Math.round(frameMs*10)/10));
      if(quality==='auto'&&time-lastAdjustment>3500){const cap=graphicsProfile('auto',window.devicePixelRatio,cinema.hdr).pixelRatio;const next=adaptiveRatio(ratio,frameMs,cap);if(Math.abs(next-ratio)>.02){ratio=next;resize();lastAdjustment=time;}}
      frames=0;elapsedMs=0;frameSamples=[];windowStart=time;}
  }
  function resetMetricWindow(){frameSamples=[];windowStart=0;frames=0;elapsedMs=0;lastTime=0;}
  function boundedError(error:unknown){return (error instanceof Error?error.message:'Unknown rendering error').slice(0,240);}
  function disposeAsset(asset:SplatMesh){asset.removeFromParent();asset.dispose();}
  function stopCapture(){pendingCapture?.dispose();pendingCapture=null;capture?.dispose();capture=null;captureBundle=null;}
  function disposeView(loseContext=true){
    if(disposed)return;disposed=true;importGeneration++;singleImportAbort?.abort();stopCapture();cancelAnimationFrame(raf);observer.disconnect();canvas.removeEventListener('webglcontextlost',contextLost);controls.dispose();if(imported)disposeAsset(imported);imported=undefined;cinema.dispose();photographic?.dispose();architecture.dispose();entities.dispose();disposeGroup(atmosphere);sun.shadow.map?.dispose();environment.dispose();spark.dispose();renderer.dispose();if(loseContext)renderer.forceContextLoss();
  }
  function failRenderer(message:string){
    if(disposed)return;failed=true;const snapshot={...metrics(0,0),backend:'unavailable' as const,status:message};
    if(capture&&captureBundle)options.onCaptureState?.({...capture.getState(),loading:false,error:message.slice(0,240)},captureBundle);
    disposeView(false);options.onMetrics(snapshot);
  }
  function serialDecode<R>(work:()=>Promise<R>):Promise<R>{const result=decodeTail.then(work);decodeTail=result.then(()=>{},()=>{});return result;}
  async function decodeAsset(data:Awaited<ReturnType<typeof preflightSplat>>,fileName:string,signal:AbortSignal,bounds?:CaptureManifest['bounds']):Promise<SplatMesh>{
    if(signal.aborted||disposed||failed)throw new Error('Import cancelled.');
    let candidate:SplatMesh|undefined;
    try{candidate=new SplatMesh({fileBytes:data.bytes,fileType:data.fileType,fileName,raycastable:false,lod:false});await candidate.initialized;
      if(signal.aborted||disposed||failed)throw new Error('Import cancelled.');
      if(candidate.numSplats<1||candidate.numSplats>MAX_IMPORT_SPLATS)throw new Error('Decoded asset exceeds the 500,000 Gaussian limit.');
      const box=candidate.getBoundingBox(false),size=box.getSize(new T.Vector3());
      if(box.isEmpty()||![...box.min.toArray(),...box.max.toArray()].every(Number.isFinite)||Math.max(size.x,size.y,size.z)>10_000)throw new Error('Asset has invalid or excessive spatial bounds.');
      if(bounds){const min=new T.Vector3(...bounds.min),max=new T.Vector3(...bounds.max);const extent=max.clone().sub(min),tolerance=.01+Math.max(extent.x,extent.y,extent.z)*.001;
        for(const axis of ['x','y','z'] as const)if(box.min[axis]<min[axis]-tolerance||box.max[axis]>max[axis]+tolerance)throw new Error('Decoded frame exceeds the declared shared capture bounds.');
        const transform=capturePreviewTransform(bounds);candidate.scale.setScalar(transform.scale);candidate.position.fromArray(transform.position);
      }else{const scale=18/Math.max(size.x,size.y,size.z,.01),center=box.getCenter(new T.Vector3());candidate.scale.setScalar(scale);candidate.position.set(-center.x*scale,-box.min.y*scale,-center.z*scale);}
      return candidate;
    }catch(error){candidate?.dispose();throw error;}
  }
  options.onMetrics(metrics(0,0));raf=requestAnimationFrame(loop);
  return {
    setFrame(frame){if(disposed||failed)return;lastFrame=frame;entities.update(frame);},
    setMode(value){if(disposed)return;mode=value;resetMetricWindow();applyMode();options.onMetrics(metrics(0,0));},
    setQuality(value){if(disposed)return;quality=value;const profile=graphicsProfile(value,window.devicePixelRatio,cinema.hdr);ratio=profile.pixelRatio;renderer.shadowMap.enabled=profile.shadows;if(sun.shadow.mapSize.x!==profile.shadowSize){sun.shadow.map?.dispose();sun.shadow.map=null;sun.shadow.mapSize.set(profile.shadowSize,profile.shadowSize);}cinema.configure(profile);spark.maxStdDev=value==='performance'?Math.sqrt(5):Math.sqrt(7);resetMetricWindow();resize();options.onMetrics(metrics(0,0));},
    setExposure(value){if(disposed)return;renderer.toneMappingExposure=clampExposure(value);resetMetricWindow();options.onMetrics(metrics(0,0));},
    cameraPreset(name){if(disposed)return;const preset=PRESETS[name];controls.lookAt(preset.position,preset.target);},
    move(forward,right){if(!disposed)controls.move(forward*.4,right*.4);},
    reset(){if(disposed)return;resetMetricWindow();importGeneration++;singleImportAbort?.abort();stopCapture();if(imported)disposeAsset(imported);imported=undefined;importName='';camera.fov=64;camera.updateProjectionMatrix();controls.lookAt(PRESETS.overview.position,PRESETS.overview.target);applyMode();options.onMetrics(metrics(0,0));},
    async loadSplat(file){
      if(disposed||failed)throw new Error('The GPU renderer is unavailable.');if(loading)throw new Error('Wait for the current import to finish.');
      loading=true;const generation=++importGeneration,prior=capture;prior?.suspend();const abort=new AbortController();singleImportAbort=abort;let candidate:SplatMesh|undefined,committed=false;
      try{candidate=await serialDecode(async()=>{if(abort.signal.aborted)throw new Error('Import cancelled.');const data=await preflightSplat(file);return decodeAsset(data,file.name,abort.signal);});
        if(disposed||failed||generation!==importGeneration)throw new Error('Import cancelled.');
        scene.add(candidate);stopCapture();const previous=imported;imported=candidate;candidate=undefined;if(previous)disposeAsset(previous);importName=file.name;committed=true;resetMetricWindow();applyMode();options.onMetrics(metrics(0,0));
      }finally{candidate?.dispose();if(singleImportAbort===abort)singleImportAbort=null;loading=false;if(!committed&&!disposed&&!failed&&generation===importGeneration&&capture===prior)prior?.resume();}
    },
    async loadCapture(bundle:CaptureBundle):Promise<CapturePlaybackState>{
      if(disposed||failed)throw new Error('The GPU renderer is unavailable.');if(loading)throw new Error('Wait for the current import to finish.');assertCaptureBundle(bundle);capturePreviewTransform(bundle.manifest.bounds);
      loading=true;const generation=++importGeneration,prior=capture;prior?.suspend();let committed=false;
      let player!:CapturePlayback<SplatMesh>;
      player=new CapturePlayback<SplatMesh>({frames:bundle.manifest.frames,duration:bundle.manifest.duration,select:time=>selectCaptureFrame(bundle.manifest,time),
        decode:(index,signal)=>serialDecode(async()=>{if(signal.aborted||disposed||failed)throw new Error('Capture loading cancelled.');const data=await loadCaptureFrame(bundle,index);return decodeAsset(data,bundle.manifest.frames[index]!.file,signal,bundle.manifest.bounds);}),
        display:asset=>{if(capture===player&&!disposed&&!failed)scene.add(asset);},disposeAsset,
        onState:state=>{if(capture===player&&!disposed&&!failed)options.onCaptureState?.(state,bundle);}});
      pendingCapture=player;
      try{player.seek(0);const initial=await player.settled();if(disposed||failed||generation!==importGeneration)throw new Error('Capture loading cancelled.');
        if(initial.displayedIndex===null||!player.displayedAsset)throw new Error((initial.error??'The first capture frame failed to load.').slice(0,240));
        scene.add(player.displayedAsset);const previousCapture=capture,previousImport=imported;capture=player;captureBundle=bundle;pendingCapture=null;imported=undefined;importName='';committed=true;
        previousCapture?.dispose();if(previousImport)disposeAsset(previousImport);resetMetricWindow();applyMode();controls.lookAt([3.2,3,11],[0,2,-1]);options.onMetrics(metrics(0,0));options.onCaptureState?.(initial,bundle);return initial;
      }finally{if(!committed)player.dispose();if(pendingCapture===player)pendingCapture=null;loading=false;if(!committed&&!disposed&&!failed&&generation===importGeneration&&capture===prior)prior?.resume();}
    },
    seekCapture(time){if(!disposed&&!failed)capture?.seek(time);},
    retryCapture(){if(!disposed&&!failed&&!loading)capture?.retry();},
    dispose(){disposeView();},
  };
  }catch(error){for(const cleanup of startupCleanup.reverse()){try{cleanup();}catch{/* Continue releasing independent resources. */}}return unavailable(options,`GPU initialization failed: ${error instanceof Error?error.message:'unknown error'}`);}
}
function makeAtmosphere():T.Group{
  const root=new T.Group();const sky=new T.Mesh(new T.SphereGeometry(180,24,16),new T.ShaderMaterial({side:T.BackSide,depthWrite:false,uniforms:{top:{value:new T.Color(0x7292b0).convertLinearToSRGB()},bottom:{value:new T.Color(0xeee1c6).convertLinearToSRGB()}},vertexShader:'varying vec3 vDirection;void main(){vDirection=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',fragmentShader:'uniform vec3 top;uniform vec3 bottom;varying vec3 vDirection;void main(){float h=normalize(vDirection).y;vec3 c=mix(bottom,top,smoothstep(-.04,.75,h));float sun=pow(max(dot(normalize(vDirection),normalize(vec3(-.35,.28,-.8))),0.0),350.0);gl_FragColor=vec4(c+sun*vec3(.8,.62,.35),1.0);}'}));root.add(sky);
  for(let layer=0;layer<3;layer++){const points:number[]=[];for(let x=-110;x<110;x+=3){const h=(Math.sin(x*.09+layer)*3+Math.sin(x*.22)*1.3+5+layer*1.6);points.push(x,-2,-45-layer*14,x,h,-45-layer*14,x+3,-2,-45-layer*14,x+3,-2,-45-layer*14,x,h,-45-layer*14,x+3,(Math.sin((x+3)*.09+layer)*3+Math.sin((x+3)*.22)*1.3+5+layer*1.6),-45-layer*14);}const geometry=new T.BufferGeometry();geometry.setAttribute('position',new T.Float32BufferAttribute(points,3));geometry.computeVertexNormals();root.add(new T.Mesh(geometry,new T.MeshBasicMaterial({color:[0x727f72,0x89938b,0xa6aea5][layer],side:T.DoubleSide})));}
  return root;
}
