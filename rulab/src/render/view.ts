import * as T from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import type { ViewOptions, RuLabView, RenderMetrics, WorldFrame, ViewMode, Quality } from '../contracts';
import { makeArchitecture, disposeGroup } from './architecture';
import { makeEntities } from './objects';
import { makeControls, type Position3 } from './controls';
import { preflightSplat, MAX_IMPORT_SPLATS } from './imports';

const PRESETS:Record<'overview'|'robot'|'drone'|'rf',{position:Position3;target:Position3}>={
  overview:{position:[3.2,2.45,10],target:[0,2,-4]}, robot:{position:[3.7,2.8,3.1],target:[0,1.9,-2]},
  drone:{position:[4.8,5.7,5.4],target:[0,4.8,0]}, rf:{position:[3.8,2.3,1.9],target:[9,2,-3]},
};
function unavailable(options:ViewOptions,status:string):RuLabView{
  options.onMetrics({backend:'unavailable',fps:0,frameMs:0,splatCount:0,drawCalls:0,camera:[3.2,-10,2.45],status});
  return {setFrame(){},setMode(){},setQuality(){},cameraPreset(){},move(){},reset(){},async loadSplat(){throw new Error('Gaussian rendering requires WebGL2. Try a browser with GPU access.');},dispose(){}};
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
  sun.shadow.mapSize.set(2048,2048);sun.shadow.camera.left=-22;sun.shadow.camera.right=22;sun.shadow.camera.top=24;sun.shadow.camera.bottom=-24;sun.shadow.camera.near=.1;sun.shadow.camera.far=65;sun.shadow.bias=-.00045;sun.shadow.normalBias=.055;
  for(const z of [-11,0,11]){const fill=new T.PointLight(0xffc888,55,20,2);fill.position.set(-4,5,z);scene.add(fill);}
  const rfLight=new T.PointLight(0xd3e2f2,26,8,2);rfLight.position.set(9.4,3.6,-3);scene.add(rfLight);
  const environmentRoom=new RoomEnvironment();const pmrem=new T.PMREMGenerator(renderer);const environment=pmrem.fromScene(environmentRoom,.08);startupCleanup.push(()=>environment.dispose());scene.environment=environment.texture;scene.environmentIntensity=.62;environmentRoom.dispose();pmrem.dispose();if(startupShaderFailed)throw new Error('GPU environment shader initialization failed.');
  const raycaster=new T.Raycaster();let disposed=false,failed=false,importGeneration=0,loading=false;
  let imported:SplatMesh|undefined,mode:ViewMode='cinematic',quality:Quality='auto',lastFrame:WorldFrame|undefined;
  let importName='';let ratio=Math.min(window.devicePixelRatio||1,1.5);let raf=0,lastTime=0,windowStart=0,frames=0,elapsedMs=0,lastAdjustment=0;let frameSamples:number[]=[];
  const controls=makeControls(canvas,camera,(x,y)=>{if(disposed||failed||imported)return;const r=canvas.getBoundingClientRect();raycaster.setFromCamera(new T.Vector2((x-r.left)/r.width*2-1,-((y-r.top)/r.height)*2+1),camera);
    const hits=raycaster.intersectObjects(entities.pickables,true);for(const hit of hits){let object:T.Object3D|null=hit.object;while(object){if(typeof object.userData.entityId==='string'){options.onSelect(object.userData.entityId);return;}object=object.parent;}}
  });
  startupCleanup.push(()=>controls.dispose());controls.lookAt(PRESETS.overview.position,PRESETS.overview.target);
  function status(){return importName?`Local asset: ${importName}. Preview normalized; coordinates and provenance unverified.`:'Authored RuLab. Gaussian surfaces and mesh objects. Scripted replay.';}
  function metrics(fps:number,frameMs:number):RenderMetrics{return {backend:failed?'unavailable':'webgl2',fps,frameMs,frameTimesMs:[...frameSamples],splatCount:imported?.numSplats??(architecture.splats.numSplats+entities.splatCount),drawCalls:renderer.info.render.calls,camera:[camera.position.x,-camera.position.z,camera.position.y],status:status()};}
  function applyMode(){entities.root.visible=!imported;controls.setCollisionEnabled(!imported);architecture.meshes.visible=!imported&&mode!=='splats';architecture.splats.visible=!imported;architecture.splats.opacity=mode==='cinematic'?.26:mode==='graph'?.16:.96;entities.setGraph(mode==='graph');scene.fog=mode==='splats'?null:new T.FogExp2(0x777b7b,.014);}
  function resize(){if(disposed)return;const r=canvas.getBoundingClientRect();const w=Math.max(1,Math.round(r.width)),h=Math.max(1,Math.round(r.height));renderer.setPixelRatio(ratio);renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix();}
  const observer=new ResizeObserver(resize);startupCleanup.push(()=>observer.disconnect());observer.observe(canvas);resize();applyMode();
  function contextLost(e:Event){e.preventDefault();failed=true;cancelAnimationFrame(raf);options.onMetrics({...metrics(0,0),backend:'unavailable',status:'GPU context lost. Reload to restore the 3D renderer.'});}
  canvas.addEventListener('webglcontextlost',contextLost);
  renderer.debug.onShaderError=()=>{if(!failed){failed=true;cancelAnimationFrame(raf);options.onMetrics({...metrics(0,0),backend:'unavailable',status:'A required GPU shader could not compile. Reference image mode is active.'});}};
  function loop(time:number){if(disposed||failed)return;raf=requestAnimationFrame(loop);if(document.hidden){lastTime=0;windowStart=time;frames=0;elapsedMs=0;frameSamples=[];return;}const dt=lastTime?(time-lastTime)/1000:1/60;lastTime=time;controls.update(dt);
    try{renderer.render(scene,camera);}catch(error){failed=true;cancelAnimationFrame(raf);options.onMetrics({...metrics(0,0),backend:'unavailable',status:`GPU rendering failed: ${error instanceof Error?error.message:'unknown error'}`});return;}
    if(failed)return;frames++;elapsedMs+=dt*1000;frameSamples.push(dt*1000);if(!windowStart)windowStart=time;
    if(time-windowStart>=750){const frameMs=elapsedMs/frames;const fps=1000/frameMs;options.onMetrics(metrics(Math.round(fps),Math.round(frameMs*10)/10));
      if(quality==='auto'&&time-lastAdjustment>3500){const cap=Math.min(window.devicePixelRatio||1,1.5);const next=frameMs>32?Math.max(.7,ratio-.15):frameMs<18?Math.min(cap,ratio+.1):ratio;if(Math.abs(next-ratio)>.02){ratio=next;resize();lastAdjustment=time;}}
      frames=0;elapsedMs=0;frameSamples=[];windowStart=time;}
  }
  options.onMetrics(metrics(0,0));raf=requestAnimationFrame(loop);
  return {
    setFrame(frame){if(disposed||failed)return;lastFrame=frame;entities.update(frame);},
    setMode(value){if(disposed)return;mode=value;applyMode();},
    setQuality(value){if(disposed)return;quality=value;ratio=value==='performance'?.85:Math.min(window.devicePixelRatio||1,value==='quality'?1.85:1.5);renderer.shadowMap.enabled=value!=='performance';spark.maxStdDev=value==='performance'?Math.sqrt(5):Math.sqrt(7);resize();},
    cameraPreset(name){if(disposed)return;const preset=PRESETS[name];controls.lookAt(preset.position,preset.target);},
    move(forward,right){if(!disposed)controls.move(forward*.4,right*.4);},
    reset(){if(disposed)return;importGeneration++;imported?.removeFromParent();imported?.dispose();imported=undefined;importName='';camera.fov=64;camera.updateProjectionMatrix();controls.lookAt(PRESETS.overview.position,PRESETS.overview.target);applyMode();options.onMetrics(metrics(0,0));},
    async loadSplat(file){if(disposed||failed)throw new Error('The GPU renderer is unavailable.');if(loading)throw new Error('Wait for the current splat import to finish.');loading=true;const generation=++importGeneration;let candidate:SplatMesh|undefined;
      try{const {bytes,fileType}=await preflightSplat(file);if(disposed||generation!==importGeneration)throw new Error('Import cancelled.');
        candidate=new SplatMesh({fileBytes:bytes,fileType,fileName:file.name,raycastable:false,lod:false});await candidate.initialized;
        if(disposed||generation!==importGeneration)throw new Error('Import cancelled.');
        if(candidate.numSplats<1||candidate.numSplats>MAX_IMPORT_SPLATS)throw new Error('Decoded asset exceeds the 500,000 Gaussian limit.');
        const bounds=candidate.getBoundingBox(false);const size=bounds.getSize(new T.Vector3());if(bounds.isEmpty()||![...bounds.min.toArray(),...bounds.max.toArray()].every(Number.isFinite)||Math.max(size.x,size.y,size.z)>10_000)throw new Error('Asset has invalid or excessive spatial bounds.');
        // Preview normalization is not a metric alignment with the graph.
        const scale=18/Math.max(size.x,size.y,size.z,.01),center=bounds.getCenter(new T.Vector3());candidate.scale.setScalar(scale);candidate.position.set(-center.x*scale,-bounds.min.y*scale,-center.z*scale);
        scene.add(candidate);const previous=imported;imported=candidate;candidate=undefined;previous?.removeFromParent();previous?.dispose();importName=file.name;applyMode();if(lastFrame)entities.update(lastFrame);options.onMetrics(metrics(0,0));
      }finally{candidate?.dispose();loading=false;}
    },
    dispose(){if(disposed)return;disposed=true;importGeneration++;cancelAnimationFrame(raf);observer.disconnect();canvas.removeEventListener('webglcontextlost',contextLost);controls.dispose();imported?.dispose();architecture.dispose();entities.dispose();disposeGroup(atmosphere);sun.shadow.map?.dispose();environment.dispose();spark.dispose();renderer.dispose();renderer.forceContextLoss();},
  };
  }catch(error){for(const cleanup of startupCleanup.reverse()){try{cleanup();}catch{/* Continue releasing independent resources. */}}return unavailable(options,`GPU initialization failed: ${error instanceof Error?error.message:'unknown error'}`);}
}
function makeAtmosphere():T.Group{
  const root=new T.Group();const sky=new T.Mesh(new T.SphereGeometry(180,24,16),new T.ShaderMaterial({side:T.BackSide,depthWrite:false,uniforms:{top:{value:new T.Color(0x7292b0).convertLinearToSRGB()},bottom:{value:new T.Color(0xeee1c6).convertLinearToSRGB()}},vertexShader:'varying vec3 vDirection;void main(){vDirection=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',fragmentShader:'uniform vec3 top;uniform vec3 bottom;varying vec3 vDirection;void main(){float h=normalize(vDirection).y;vec3 c=mix(bottom,top,smoothstep(-.04,.75,h));float sun=pow(max(dot(normalize(vDirection),normalize(vec3(-.35,.28,-.8))),0.0),350.0);gl_FragColor=vec4(c+sun*vec3(.8,.62,.35),1.0);}'}));root.add(sky);
  for(let layer=0;layer<3;layer++){const points:number[]=[];for(let x=-110;x<110;x+=3){const h=(Math.sin(x*.09+layer)*3+Math.sin(x*.22)*1.3+5+layer*1.6);points.push(x,-2,-45-layer*14,x,h,-45-layer*14,x+3,-2,-45-layer*14,x+3,-2,-45-layer*14,x,h,-45-layer*14,x+3,(Math.sin((x+3)*.09+layer)*3+Math.sin((x+3)*.22)*1.3+5+layer*1.6),-45-layer*14);}const geometry=new T.BufferGeometry();geometry.setAttribute('position',new T.Float32BufferAttribute(points,3));geometry.computeVertexNormals();root.add(new T.Mesh(geometry,new T.MeshBasicMaterial({color:[0x727f72,0x89938b,0xa6aea5][layer],side:T.DoubleSide})));}
  return root;
}
