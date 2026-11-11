import * as T from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { SplatMesh, PackedSplats } from '@sparkjsdev/spark';

/** Authored geometry, in metres. No image projection or measured geometry claim. */
export interface Architecture { meshes: T.Group; splats: SplatMesh; dispose():void }
export function makeArchitecture(): Architecture {
  const meshes = new T.Group(); meshes.name = 'RuLab authored architecture';
  const batches = new Map<T.Material,T.BufferGeometry[]>();
  const ownedTextures: T.Texture[]=[];
  const concreteTex=surfaceTexture('concrete'); ownedTextures.push(concreteTex);
  const woodTex=surfaceTexture('wood'); ownedTextures.push(woodTex);
  const concrete = new T.MeshPhysicalMaterial({color:0x8b8278,roughness:.27,metalness:.12,clearcoat:.45,clearcoatRoughness:.18,map:concreteTex,roughnessMap:concreteTex,bumpMap:concreteTex,bumpScale:.018});
  const wood = new T.MeshStandardMaterial({color:0xa37443,roughness:.58,map:woodTex,bumpMap:woodTex,bumpScale:.016});
  concrete.name='concrete';wood.name='wood';
  const dark = new T.MeshStandardMaterial({color:0x22282b,roughness:.44,metalness:.65});
  const white = new T.MeshStandardMaterial({color:0xc7c6bc,roughness:.63});
  const steel = new T.MeshStandardMaterial({color:0xa0a19c,roughness:.28,metalness:.85});
  const light = new T.MeshBasicMaterial({color:new T.Color(0xffd198).multiplyScalar(2.5)});
  const black = new T.MeshStandardMaterial({color:0x111719,roughness:.88});
  const glass = new T.MeshPhysicalMaterial({color:0xcedee2,transparent:true,opacity:.13,roughness:.08,metalness:.08,depthWrite:false});
  const green = new T.MeshStandardMaterial({color:0x344721,roughness:.88});
  const yellow = new T.MeshStandardMaterial({color:0xe0b855,roughness:.65});
  function put(geometry:T.BufferGeometry,material:T.Material,position:T.Vector3,rotation?:T.Euler){
    const matrix=new T.Matrix4().compose(position,new T.Quaternion().setFromEuler(rotation??new T.Euler()),new T.Vector3(1,1,1));
    geometry.applyMatrix4(matrix);const b=batches.get(material)??[];b.push(geometry);batches.set(material,b);
  }
  const box=(w:number,h:number,d:number,x:number,y:number,z:number,m:T.Material=dark)=>put(new T.BoxGeometry(w,h,d),m,new T.Vector3(x,y,z));
  function bar(a:T.Vector3,b:T.Vector3,r=.04,m:T.Material=dark){const q=new T.Quaternion().setFromUnitVectors(new T.Vector3(0,1,0),b.clone().sub(a).normalize());const g=new T.CylinderGeometry(r,r,a.distanceTo(b),6);g.applyQuaternion(q);put(g,m,a.clone().add(b).multiplyScalar(.5));}
  // Single coherent shell, with actual depth, occlusion and translation parallax.
  box(24,.22,34,0,-.12,0,concrete);
  box(.24,11,34,-12,5.5,0,white);box(.24,11,34,12,5.5,0,white);
  box(24,.18,34,0,11.05,0,white);
  box(24,1, .18,0,.5,-17,dark);
  for(let x=-12;x<=12;x+=3){box(.12,10,.14,x,6,-17,steel);box(.1,10,.1,x,6,17,dark);}
  for(let y=1;y<=11;y+=2.5){box(24,.08,.13,0,y,-17,steel);box(24,.08,.13,0,y,17,dark);}
  box(24,10,.04,0,6,-17,glass);box(24,10,.04,0,6,17,glass);
  // Heavy mezzanine, continuous timber fins and offices along the left facade.
  box(4.8,.36,32,-9.45,4.25,0,dark);box(4.8,.25,32,-9.45,8.65,0,dark);
  box(.18,8.6,32,-11.6,4.3,0,wood);
  for(let z=-15.8;z<=16;z+=.2)if([-13,-5,3,11].some(center=>Math.abs(z-center)<.66))box(.16,8.2,.09,-7.3,4.25,z,wood);
  // Large openings in front of the timber grid make the mezzanine legible.
  for(const z of [-11,-3,5,13]){
    box(.18,3.45,6.8,-7.13,2.1,z,glass);box(.18,3.35,6.8,-7.13,6.4,z,glass);
    box(.18,8.6,.16,-7.05,4.3,z-3.5,dark);
    box(.15,.065,6.8,-6.99,4,z,light);box(.15,.055,6.8,-6.99,8.4,z,light);
    box(2.3,.09,1.1,-9,1.05,z,wood);box(.1,1.05,.1,-10,.52,z,dark);
    box(.1,1.05,.1,-8,.52,z,dark);box(.75,.47,.06,-9,1.35,z-.2,black);
  }
  // Exposed trusses, diagonal bracing, suspended lighting and cable trays.
  for(let z=-15;z<=15;z+=5){
    box(24,.15,.15,0,9.1,z);box(24,.13,.13,0,10.05,z);
    for(let x=-12;x<12;x+=2){bar(new T.Vector3(x,9.1,z),new T.Vector3(x+2,10.05,z));bar(new T.Vector3(x,10.05,z),new T.Vector3(x+2,9.1,z));}
    for(const x of [-6.8,6.8]){box(.18,9.15,.2,x,4.55,z);box(.09,1.1,.09,x,8.45,z);box(3,.07,.14,x,7.91,z,light);}
  }
  for(const x of [-3.5,3.5]){box(.22,.25,32,x,10.55,0,dark);for(let z=-13;z<=13;z+=4)box(.075,.08,2.5,x,8.4,z,light);}
  // RF chamber: thick wall, lined interior, opening on its west face.
  box(4.05,4.5,.25,9.8,2.25,-6,steel);box(4.05,4.5,.25,9.8,2.25,.1,steel);
  box(.23,4.5,6.1,11.7,2.25,-3,steel);box(4.05,.2,6.1,9.8,4.5,-3,steel);
  box(.2,.62,6.1,7.78,4.14,-3,steel);box(.2,3.8,1.4,7.78,1.9,-5.3,steel);
  box(.2,3.8,1.4,7.78,1.9,-.6,steel);box(3.8,.12,5.8,9.8,.05,-3,dark);
  for(let z=-5.5;z<-.3;z+=.28)for(let y=.35;y<3.9;y+=.28){
    put(new T.ConeGeometry(.18,.23,4),black,new T.Vector3(11.45,y,z),new T.Euler(0,0,Math.PI/2));
  }
  box(.14,.065,6.05,7.62,4.48,-3,light);
  // Work benches and trolley drawers, leaving the central AMR aisle clear.
  for(const [x,z] of [[-4,-5],[-4,4],[4,-7],[4,4]] as const){
    box(2.2,.13,1.1,x,1.04,z,wood);box(2.12,.1,1.03,x,.35,z,dark);
    for(const dx of [-.94,.94]){box(.08,.94,.08,x+dx,.52,z-.42);box(.08,.94,.08,x+dx,.52,z+.42);}
    box(.7,.62,.9,x+.5,.65,z,dark);
    for(let y=.45;y<.98;y+=.13)box(.5,.018,.02,x+.5,y,z+.46,steel);
    box(.8,.47,.04,x-.5,1.48,z-.24,black);box(.05,.3,.05,x-.5,1.19,z-.24,steel);
    box(.79,.44,.012,x-.5,1.49,z-.212,new T.MeshBasicMaterial({color:0x335c67}));
    box(.46,.05,.17,x-.5,1.14,z+.17,black);
  }
  for(const z of [-12,10])for(const x of [-5.8,5.9]){
    put(new T.CylinderGeometry(.39,.34,.7,24),concrete,new T.Vector3(x,.35,z));
    bar(new T.Vector3(x,.6,z),new T.Vector3(x,2.35,z),.024,wood);
    for(let i=0;i<9;i++){const a=i*2.399,y=1.35+i*.105,length=.3+(i%3)*.09;
      const from=new T.Vector3(x,y,z),tip=new T.Vector3(x+Math.cos(a)*length,y+.27,z+Math.sin(a)*length);
      bar(from,tip,.008,wood);
      for(let j=1;j<=7;j++){const t=j/8,leaf=from.clone().lerp(tip,t),side=j%2?1:-1;leaf.x+=Math.cos(a+Math.PI/2)*.05*side;leaf.z+=Math.sin(a+Math.PI/2)*.05*side;
        const g=new T.SphereGeometry(.045,5,3);g.scale(1,.12,2.55);put(g,green,leaf,new T.Euler(.25,a+.65*side,-.3*side));}}

  }
  // Lounge in the near left foreground.
  box(2.1,.4,1,-4.7,.45,12,white);box(2.1,.8,.22,-4.7,.8,12.47,white);
  box(.2,.65,1,-5.8,.7,12,white);box(.2,.65,1,-3.6,.7,12,white);
  put(new T.CylinderGeometry(.76,.76,.08,32),dark,new T.Vector3(-4.7,.57,10.5));
  put(new T.CylinderGeometry(.27,.34,.53,16),dark,new T.Vector3(-4.7,.28,10.5));
  box(3.8,.012,3.8,-4.7,.012,11.5,new T.MeshStandardMaterial({color:0x9b8c70,roughness:1}));
  // Painted aisle, actual floor plane primitives; no screen-space overlays.
  for(const x of [-2.15,2.15])box(.055,.012,27,x,.009,0,yellow);
  for(const z of [-10,-1,8])for(let i=0;i<8;i++)box(.24,.012,.04,-1.9+i*.52,.011,z,yellow);
  // Physical signage, authored text only.
  const sign=makeSign('RuLab','SPATIAL INTELLIGENCE / RESEARCH HALL');ownedTextures.push(sign);
  const signMesh=new T.Mesh(new T.PlaneGeometry(4.5,1.4),new T.MeshBasicMaterial({map:sign}));
  signMesh.position.set(-6.94,6.35,-1);signMesh.rotation.y=Math.PI/2;meshes.add(signMesh);
  const rfSign=makeSign('RF SUITE','SHIELDED / MODULAR / RECONFIGURABLE');ownedTextures.push(rfSign);
  const rfLabel=new T.Mesh(new T.PlaneGeometry(4.7,.95),new T.MeshBasicMaterial({map:rfSign}));rfLabel.position.set(7.62,3.85,-3);rfLabel.rotation.y=-Math.PI/2;meshes.add(rfLabel);
  for(const [mat,gs]of batches){const merged=mergeGeometries(gs,false);if(merged){const mesh=new T.Mesh(merged,mat);mesh.castShadow=mat!==glass&&mat!==light;mesh.receiveShadow=true;meshes.add(mesh);}gs.forEach(g=>g.dispose());}

  // Surface-aligned anisotropic Gaussian primitives distributed in actual 3D.
  // Narrow normal-axis scale keeps surfaces spatially thin; colours are authored.
  const packed=new PackedSplats({maxSplats:65000});
  let seed=4133;const rand=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  const p=new T.Vector3(),s=new T.Vector3(),q=new T.Quaternion(),c=new T.Color();
  function surface(origin:T.Vector3,u:T.Vector3,v:T.Vector3,w:number,h:number,step:number,color:T.Color,grain=.08){
    const normal=u.clone().cross(v).normalize();const basis=new T.Matrix4().makeBasis(u,v,normal);q.setFromRotationMatrix(basis);
    for(let a=-w/2;a<=w/2;a+=step)for(let b=-h/2;b<=h/2;b+=step){
      p.copy(origin).addScaledVector(u,a+(rand()-.5)*step*.3).addScaledVector(v,b+(rand()-.5)*step*.3);
      s.set(step*.66,step*.66,.008);c.copy(color).convertLinearToSRGB().multiplyScalar(.94+rand()*grain);packed.pushSplat(p,s,q,.82,c);
    }
  }
  surface(new T.Vector3(0,.027,0),new T.Vector3(1,0,0),new T.Vector3(0,0,-1),24,34,.21,new T.Color(0x8b8377),.1);
  surface(new T.Vector3(-11.83,5.5,0),new T.Vector3(0,0,1),new T.Vector3(0,1,0),34,11,.22,new T.Color(0xb89466),.16);
  surface(new T.Vector3(11.84,5.5,0),new T.Vector3(0,0,-1),new T.Vector3(0,1,0),34,11,.27,new T.Color(0x9e9b90),.07);
  surface(new T.Vector3(0,10.92,0),new T.Vector3(1,0,0),new T.Vector3(0,0,1),24,34,.32,new T.Color(0x756e5d),.12);
  for(const z of [-13,-5,3,11])surface(new T.Vector3(-7.08,6.3,z),new T.Vector3(0,0,1),new T.Vector3(0,1,0),1.2,3.6,.085,new T.Color(0xbc854b),.18);
  const splats=new SplatMesh({packedSplats:packed,raycastable:false});splats.name='Authored architectural Gaussians';
  return {meshes,splats,dispose(){splats.dispose();ownedTextures.forEach(t=>t.dispose());disposeGroup(meshes);}};
}

function surfaceTexture(kind:'wood'|'concrete'):T.CanvasTexture{
  const canvas=document.createElement('canvas');canvas.width=512;canvas.height=512;const ctx=canvas.getContext('2d')!;
  const im=ctx.createImageData(512,512);let seed=7128;
  for(let y=0;y<512;y++)for(let x=0;x<512;x++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;const n=seed/4294967296;
    let v:number;
    if(kind==='wood'){
      const warp=Math.sin(y*.007)*3.4+Math.sin(y*.023+x*.012)*.6;
      const grain=Math.sin(x*.74+warp)*7+Math.sin(x*2.2+warp*.4)*2.5;
      const growth=Math.sin(x*.052+warp*.11)*10;
      const pore=Math.pow(Math.max(0,Math.sin(x*1.81+warp*.7)),14)*9;
      v=189+grain+growth-pore+n*5;
    }else{
      const mottling=Math.sin(x*.019+Math.sin(y*.012)*2)*8+Math.sin(y*.027+x*.009)*5;
      const aggregate=Math.sin(x*.48+y*.17)*Math.sin(y*.39-x*.13)*2.5;
      const seam=(x<2||y<2)?-14:0;
      v=195+mottling+aggregate+(n-.5)*7+seam;
    }
    const i=(y*512+x)*4;im.data[i]=v;im.data[i+1]=v;im.data[i+2]=v;im.data[i+3]=255;
  }
  ctx.putImageData(im,0,0);const tex=new T.CanvasTexture(canvas);tex.wrapS=tex.wrapT=T.RepeatWrapping;tex.repeat.set(kind==='wood'?1:6,kind==='wood'?1:8);tex.anisotropy=4;tex.colorSpace=T.SRGBColorSpace;return tex;
}
function makeSign(title:string,subtitle:string):T.CanvasTexture{const c=document.createElement('canvas');c.width=1024;c.height=256;const x=c.getContext('2d')!;x.fillStyle='#182022';x.fillRect(0,0,1024,256);x.fillStyle='#f2ede2';x.font='500 92px sans-serif';x.fillText(title,48,121);x.fillStyle='#c3b9a5';x.font='24px sans-serif';x.fillText(subtitle,52,190);const t=new T.CanvasTexture(c);t.colorSpace=T.SRGBColorSpace;return t;}
export function disposeGroup(root:T.Object3D){const geometries=new Set<T.BufferGeometry>(),materials=new Set<T.Material>();root.traverse(o=>{if(o instanceof T.Mesh||o instanceof T.Line){geometries.add(o.geometry);(Array.isArray(o.material)?o.material:[o.material]).forEach(m=>materials.add(m));}});geometries.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());}
