import * as T from 'three';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
/** Assets are bundled and same origin. A missing asset cannot disable navigation. */
export async function loadPhotographicAssets(renderer:T.WebGLRenderer,root:T.Object3D,scene:T.Scene,isDisposed:()=>boolean){
  const textures:T.Texture[]=[];let environment:T.WebGLRenderTarget|undefined;
  const dispose=()=>{textures.forEach(t=>t.dispose());environment?.dispose();};
  const base=import.meta.env.BASE_URL+'graphics/';const loader=new T.TextureLoader();
  let materialMaps=0,hdri=false;
  const assignments=[['concrete','concrete-diff.jpg','map',true],['concrete','concrete-rough.jpg','roughnessMap',false],['concrete','concrete-normal.jpg','normalMap',false],['wood','wood-diff.jpg','map',true],['wood','wood-rough.jpg','roughnessMap',false],['wood','wood-normal.jpg','normalMap',false]] as const;
  await Promise.all(assignments.map(async([name,file,slot,color])=>{
    let texture:T.Texture|undefined;
    try{texture=await loader.loadAsync(base+file);if(isDisposed()){texture.dispose();return;}textures.push(texture);
      texture.colorSpace=color?T.SRGBColorSpace:T.NoColorSpace;texture.wrapS=texture.wrapT=T.RepeatWrapping;
      texture.repeat.set(name==='wood'?2:8,name==='wood'?2:12);texture.anisotropy=Math.min(8,renderer.capabilities.getMaxAnisotropy());
      root.traverse(o=>{if(o instanceof T.Mesh){const materials=Array.isArray(o.material)?o.material:[o.material];for(const material of materials)if(material instanceof T.MeshStandardMaterial&&material.name===name){material[slot]=texture!;if(slot==='normalMap'){material.bumpMap=null;material.normalScale.set(.4,.4);}if(slot==='map')material.color.set(0xffffff);material.needsUpdate=true;}}});materialMaps++;
    }catch{/* Authored material remains available. */}
  }));
  try{const hdr=await new HDRLoader().loadAsync(base+'sunset.hdr');if(isDisposed()){hdr.dispose();dispose();return {dispose,materialMaps,hdri};}
    const pmrem=new T.PMREMGenerator(renderer);try{environment=pmrem.fromEquirectangular(hdr);scene.environment=environment.texture;scene.environmentIntensity=.8;hdri=true;}finally{hdr.dispose();pmrem.dispose();}
  }catch{/* Retain the generated room environment. */}
  if(isDisposed())dispose();return {dispose,materialMaps,hdri};
}
