import * as T from 'three';
import {EffectComposer} from 'three/addons/postprocessing/EffectComposer.js';
import {RenderPass} from 'three/addons/postprocessing/RenderPass.js';
import {UnrealBloomPass} from 'three/addons/postprocessing/UnrealBloomPass.js';
import {OutputPass} from 'three/addons/postprocessing/OutputPass.js';
import {ShaderPass} from 'three/addons/postprocessing/ShaderPass.js';
import {FXAAShader} from 'three/addons/shaders/FXAAShader.js';
import {Reflector} from 'three/addons/objects/Reflector.js';
import type {GraphicsProfile} from './quality';
/** HDR output is tone mapped once, then antialiased in display space. */
export function makeCinema(renderer:T.WebGLRenderer,scene:T.Scene,camera:T.Camera,exclude:T.Object3D[]){
  const hdr=renderer.extensions.has('EXT_color_buffer_float');
  const target=new T.WebGLRenderTarget(1,1,{type:hdr?T.HalfFloatType:T.UnsignedByteType,depthBuffer:true});
  const composer=new EffectComposer(renderer,target);const render=new RenderPass(scene,camera);
  const bloom=new UnrealBloomPass(new T.Vector2(1,1),.18,.45,1.25);const output=new OutputPass();const fxaa=new ShaderPass(FXAAShader);
  composer.addPass(render);composer.addPass(bloom);composer.addPass(output);composer.addPass(fxaa);
  const floor=new Reflector(new T.PlaneGeometry(23.6,33.6),{textureWidth:512,textureHeight:512,color:0x8c8174,multisample:0,clipBias:.003});
  floor.name='Mesh floor reflection';floor.rotation.x=-Math.PI/2;floor.position.y=.005;
  const material=floor.material as T.ShaderMaterial;
  material.transparent=true;material.depthWrite=false;material.uniforms.opacity={value:.18};
  material.fragmentShader='uniform float opacity;\n'+material.fragmentShader.replace('vec4( blendOverlay( base.rgb, color ), 1.0 )','vec4( blendOverlay( base.rgb, color ), opacity )');
  // Spark sorts for the main camera. Never re-sort it for the reflection camera.
  const original=floor.onBeforeRender.bind(floor);
  floor.onBeforeRender=(...args)=>{const visible=exclude.map(o=>o.visible);exclude.forEach(o=>o.visible=false);try{original(...args);}finally{exclude.forEach((o,i)=>o.visible=visible[i]!);}};
  scene.add(floor);let enabled=true,reflectionRequested=false,authored=true;
  function configure(profile:GraphicsProfile){enabled=profile.antialias&&hdr;bloom.enabled=profile.bloom;reflectionRequested=profile.reflections;floor.visible=reflectionRequested&&authored;}
  function resize(width:number,height:number,ratio:number){composer.setPixelRatio(ratio);composer.setSize(width,height);fxaa.uniforms.resolution.value.set(1/(width*ratio),1/(height*ratio));}
  return {hdr,configure,resize,setAuthored(value:boolean){authored=value;floor.visible=value&&reflectionRequested;},
    render(){renderer.info.reset();if(enabled)composer.render();else renderer.render(scene,camera);},
    get reflectionEnabled(){return floor.visible;},
    dispose(){floor.removeFromParent();floor.geometry.dispose();floor.dispose();bloom.dispose();output.dispose();fxaa.dispose();composer.dispose();}};
}
