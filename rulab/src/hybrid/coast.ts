import * as T from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { PackedSplats, SplatMesh } from '@sparkjsdev/spark';

/** Original authored scenery. These Gaussians are appearance, never sensor evidence. */
export const COAST_SPLAT_LIMIT = 65_000;
export const COAST_REPLAY_SECONDS = 120;
const COAST_PHASE_RATE = 2*Math.PI/COAST_REPLAY_SECONDS;
export interface CoastalActorState { id:string; position:[number,number,number]; heading:number }
export interface CoastalCollisionBox { min:[number,number,number]; max:[number,number,number] }
export interface CoastalScene {
  staticMeshes:T.Group;
  dynamicMeshes:T.Group;
  splats:SplatMesh;
  readonly splatCount:number;
  collisionBoxes:CoastalCollisionBox[];
  update(timeSeconds:number):void;
  actorStates(timeSeconds:number):CoastalActorState[];
  dispose():void;
}

/** Analytic motion: seeking the same time restores identical poses, without integration drift. */
export function coastalActorStates(timeSeconds:number):CoastalActorState[] {
  const t=Number.isFinite(timeSeconds)?Math.max(0,timeSeconds)%COAST_REPLAY_SECONDS:0;
  const phase=t*COAST_PHASE_RATE;
  return [
    {id:'coast-walker-1',position:[-24+Math.sin(phase)*32,.21,-6.6+Math.cos(phase)*.6],heading:Math.atan2(Math.cos(phase)*32,-Math.sin(phase)*.6)},
    {id:'coast-walker-2',position:[-40+Math.sin(phase+.95)*28,.21,-9.8+Math.cos(phase+.95)*.7],heading:Math.atan2(Math.cos(phase+.95)*28,-Math.sin(phase+.95)*.7)},
    {id:'coast-vehicle-1',position:[-43+Math.sin(phase-1)*60,.23,-14+Math.cos(phase-1)*1.4],heading:Math.atan2(Math.cos(phase-1)*60,-Math.sin(phase-1)*1.4)},
  ];
}

export function createCoastalScene():CoastalScene {
  const staticMeshes=new T.Group();staticMeshes.name='Synthetic coast: physical surfaces';
  const dynamicMeshes=new T.Group();dynamicMeshes.name='Synthetic coast: moving mesh actors';
  const collisionBoxes:CoastalCollisionBox[]=[];
  const batches=new Map<T.Material,T.BufferGeometry[]>();
  const textures=new Set<T.Texture>();
  const materials=new Set<T.Material>();
  const geometryResources=new Set<T.BufferGeometry>();
  let disposed=false,seed=0x638a9c;
  const rand=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  function mat(color:number,roughness=.75,metalness=0){const m=new T.MeshStandardMaterial({color,roughness,metalness});materials.add(m);return m;}
  const sandTexture=makeTexture('sand');textures.add(sandTexture);
  const woodTexture=makeTexture('wood');textures.add(woodTexture);
  const sand=mat(0xdfc99e,.98);sand.map=sandTexture;sand.bumpMap=sandTexture;sand.bumpScale=.06;
  const wetSand=mat(0xb8ae8c,.42);
  const promenade=mat(0xcbbca4,.88);
  const concrete=mat(0xe8ddc5,.76);
  const ivory=mat(0xf4e8cc,.64);
  const coral=mat(0xc66d55,.7);
  const blush=mat(0xe0a391,.75);
  const seafoam=mat(0x82a99a,.72);
  const teal=mat(0x286f73,.46,.1);
  const blue=mat(0x598b9b,.4,.16);
  const deepGlass=mat(0x344d56,.34,.24);
  const wood=mat(0x92724e,.92);wood.map=woodTexture;wood.bumpMap=woodTexture;wood.bumpScale=.045;
  const trunk=mat(0x8e7753,.96);
  const dark=mat(0x343e3d,.72);
  const green=mat(0x526b37,.85);
  const lightGreen=mat(0x728448,.9);
  const seaGrass=mat(0x9b9961,.95);
  const mustard=mat(0xc9aa62,.8);
  const rubber=mat(0x232827,.94);
  const white=mat(0xe4e4d9,.45,.12);

  function put(geometry:T.BufferGeometry,material:T.Material,position:T.Vector3,rotation=new T.Euler()){
    geometry.applyMatrix4(new T.Matrix4().compose(position,new T.Quaternion().setFromEuler(rotation),new T.Vector3(1,1,1)));
    const group=batches.get(material)??[];group.push(geometry);batches.set(material,group);
  }
  function box(w:number,h:number,d:number,x:number,y:number,z:number,material:T.Material=ivory,rotation=new T.Euler()){
    put(new T.BoxGeometry(w,h,d),material,new T.Vector3(x,y,z),rotation);
  }
  function bar(a:T.Vector3,b:T.Vector3,r:number,material:T.Material=wood,segments=6){
    const g=new T.CylinderGeometry(r,r,a.distanceTo(b),segments);
    g.applyQuaternion(new T.Quaternion().setFromUnitVectors(new T.Vector3(0,1,0),b.clone().sub(a).normalize()));
    put(g,material,a.clone().add(b).multiplyScalar(.5));
  }
  function collider(x:number,z:number,w:number,d:number,h:number,y=0){collisionBoxes.push({min:[x-w/2,y,z-d/2],max:[x+w/2,y+h,z+d/2]});}

  // Physical beach, a darker tidal strip and a paved public promenade.
  box(150,.3,175,-51,-.22,19,sand);
  box(5,.1,175,25,-.09,19,wetSand);
  box(152,.24,14,-48,.08,-12,promenade);
  box(152,.14,.28,-48,.22,-4.9,ivory);
  box(152,.14,.28,-48,.22,-19.1,ivory);
  for(let x=-119;x<27;x+=3)box(.035,.01,13.5,x,.207,-12,concrete);
  for(const z of [-17,-7])box(148,.015,.065,-48,.21,z,ivory);
  // Cycling lane and narrow drainage channels are geometry, not a screen overlay.
  for(let x=-118;x<25;x+=4.2)box(1.4,.016,.11,x,.22,-12.8,ivory);

  const water=createOcean();geometryResources.add(water.geometry);materials.add(water.material);staticMeshes.add(water);

  // Distant skyline: floor plates, recessed glazing, roof plant and stepped towers.
  const buildingPalette=[ivory,concrete,blush,seafoam,promenade];
  for(let i=0;i<25;i++){
    const x=-128+i*6.4+(rand()-.5)*3,z=-79-rand()*48;
    const w=5.5+rand()*7,d=7+rand()*9,h=18+rand()*47;
    const finish=buildingPalette[i%buildingPalette.length];
    box(w,h,d,x,h/2-.1,z,finish);collider(x,z,w,d,h);
    // Continuous inset window panels keep distant buildings crisp with bounded geometry.
    box(w-.8,h-3,.07,x,h/2,z+d/2+.05,deepGlass);
    box(.07,h-3,d-.8,x+w/2+.05,h/2,z,blue);
    for(let y=2.4;y<h-.5;y+=2.4){box(w+.22,.17,d+.16,x,y,z,finish);}
    for(let sx=-w/2+.65;sx<w/2;sx+=1.45)box(.15,h-.8,.2,x+sx,h/2,z+d/2+.14,finish);
    if(i%3===0){box(w*.55,2.5,d*.55,x+.4,h+1.2,z,finish);box(.3,5,.3,x,h+3.4,z,dark);}
    if(i%5===0){box(w*.7,.25,d*.7,x,h+3,z,white);}
  }

  // A low, irregular town frontage gives the scene a human scale before the skyline.
  for(let i=0;i<12;i++){
    const x=-102+i*10.7,z=-36-rand()*8,w=9+rand()*2,d=11+rand()*6,h=5.5+(i%4)*1.5;
    const finish=buildingPalette[(i+2)%buildingPalette.length];
    box(w,h,d,x,h/2,z,finish);collider(x,z,w,d,h);
    box(w+.7,.3,d+.8,x,h,z,ivory);box(w+.3,.15,.8,x,h*.5,z+d/2+.25,concrete);
    box(w-.6,.7,.3,x,h-.55,z+d/2+.17,finish);
    for(let sx=-w/2+1.3;sx<w/2;sx+=2.35){
      box(1.4,2.3,.09,x+sx,1.55,z+d/2+.07,deepGlass);
      box(1.7,.14,.27,x+sx,.47,z+d/2+.15,ivory);
      box(1.7,.14,.27,x+sx,2.74,z+d/2+.15,ivory);
      box(1.4,1.55,.08,x+sx,h-2,z+d/2+.07,blue);
      box(.065,1.55,.1,x+sx,h-2,z+d/2+.14,ivory);
      box(1.4,.065,.1,x+sx,h-2,z+d/2+.14,ivory);
    }
    for(let n=0;n<Math.floor(w/.7);n++)box(.68,.12,1.85,x-w/2+.35+n*.7,3.05,z+d/2+.8,n%2===0?ivory:teal,new T.Euler(.15,0,0));
    // Balconies and roof water tanks vary the silhouette without external assets.
    if(i%2===0){box(w*.72,.2,1.7,x,h*.65,z+d/2+.7,concrete);for(let sx=-w*.34;sx<w*.36;sx+=.55)box(.035,.95,.035,x+sx,h*.65+.53,z+d/2+1.45,dark);box(w*.75,.045,.045,x,h*.65+1,z+d/2+1.45,dark);}
    if(i%3===0)put(new T.CylinderGeometry(.8,.8,1.6,12),ivory,new T.Vector3(x+1,h+1.1,z));
  }

  // Iconic lifeguard tower in the foreground: weathered timber, stairs and coral siding.
  const towerX=6,towerZ=23;
  for(const dx of [-1.4,1.4])for(const dz of [-1.2,1.2])box(.16,2.75,.16,towerX+dx,1.35,towerZ+dz,wood);
  box(4,.18,3.5,towerX,2.63,towerZ,wood);box(3.1,2.15,2.6,towerX,3.8,towerZ,coral);
  box(3.8,.22,3.25,towerX,4.98,towerZ,ivory,new T.Euler(0,0,.045));
  for(let y=2.86;y<4.82;y+=.2)box(3.13,.025,.04,towerX,y,towerZ+1.32,blush);
  box(2.2,.85,.07,towerX,4.1,towerZ+1.34,deepGlass);box(.05,.85,.11,towerX,4.1,towerZ+1.4,ivory);
  box(.08,.9,1.6,towerX+1.57,4.05,towerZ,deepGlass);
  for(let j=0;j<9;j++)box(1.05,.12,.4,towerX-1.35,.25+j*.28,towerZ+3.95-j*.28,wood);
  for(const dx of [-1.9,-.8])bar(new T.Vector3(towerX+dx,.8,towerZ+4.1),new T.Vector3(towerX+dx,3.15,towerZ+1.8),.045,ivory);
  for(const dx of [-1.87,1.87]){box(.06,1,.06,towerX+dx,3.25,towerZ+1.55,ivory);box(.07,.07,3.2,towerX+dx,3.72,towerZ,ivory);}
  collider(towerX,towerZ,4,3.5,5);
  addSign('07','COASTAL OBSERVATORY',towerX,3.1,towerZ+1.38,1.7,.46,0xe6dac5,0x34534d);

  // Beach pavilion with pergola, bar counter and striped canvas shade.
  const pavilionX=-32,pavilionZ=-.7;
  box(9,.28,5.5,pavilionX,.12,pavilionZ,wood);
  for(const dx of [-4.1,4.1])for(const dz of [-2.3,2.3])box(.2,3.5,.2,pavilionX+dx,1.9,pavilionZ+dz,ivory);
  for(let x=-4.5;x<=4.5;x+=.55)box(.14,.16,6.1,pavilionX+x,3.65,pavilionZ,wood);
  box(9.2,.18,.2,pavilionX,3.5,pavilionZ-2.4,wood);box(9.2,.18,.2,pavilionX,3.5,pavilionZ+2.4,wood);
  box(7.6,1.25,1,pavilionX,.92,pavilionZ-1.7,seafoam);box(7.9,.15,1.2,pavilionX,1.6,pavilionZ-1.7,ivory);
  for(let i=0;i<6;i++){put(new T.CylinderGeometry(.3,.3,.1,14),wood,new T.Vector3(pavilionX-3+i*1.2,1.06,pavilionZ+.3));bar(new T.Vector3(pavilionX-3+i*1.2,.2,pavilionZ+.3),new T.Vector3(pavilionX-3+i*1.2,1.02,pavilionZ+.3),.06,dark);}
  collider(pavilionX,pavilionZ-1.7,7.9,1.2,1.7);
  addSign('TIDE / 01','RESEARCH BEACH',pavilionX,2.7,pavilionZ-1.17,3.5,.75,0x2d6260,0xf2e4c3);

  // Real mesh umbrellas and loungers, batched by alternating fabric colour.
  const umbrellaColors=[teal,ivory,coral,seafoam,mustard];
  for(let i=0;i<32;i++){
    const row=Math.floor(i/8),x=-66+(i%8)*10.4+(row%2)*2.1,z=8+row*12+(rand()-.5)*2;
    if(Math.abs(x-towerX)<5&&Math.abs(z-towerZ)<7)continue;
    const radius=1.65+rand()*.35,y=2.45+rand()*.25,finish=umbrellaColors[i%umbrellaColors.length];
    bar(new T.Vector3(x,0,z),new T.Vector3(x,y+.1,z),.043,wood);
    put(new T.ConeGeometry(radius,.62,12,1,true),finish,new T.Vector3(x,y-.24,z));
    for(let k=0;k<12;k++){const a=k*Math.PI/6;bar(new T.Vector3(x,y+.07,z),new T.Vector3(x+Math.cos(a)*radius,y-.55,z+Math.sin(a)*radius),.012,ivory);}
    for(const side of [-1,1]){
      const lx=x+side*.95,lz=z+1.3;
      box(.64,.1,1.55,lx,.38,lz,finish);box(.64,.7,.08,lx,.68,lz-.72,finish,new T.Euler(-.35,0,0));
      for(const dz of [-.57,.57]){box(.035,.34,.035,lx-.29,.2,lz+dz,ivory);box(.035,.34,.035,lx+.29,.2,lz+dz,ivory);}
    }
  }

  // Local splat storage has a hard cap. Anisotropic leaf kernels occupy real 3D positions.
  const packed=new PackedSplats({maxSplats:COAST_SPLAT_LIMIT});
  let splatCount=0;
  const sp=new T.Vector3(),ss=new T.Vector3(),sq=new T.Quaternion(),sc=new T.Color();
  function splat(x:number,y:number,z:number,sx:number,sy:number,sz:number,color:number,opacity=.72,rotation=0){
    if(splatCount>=COAST_SPLAT_LIMIT)throw new Error('Authored coast exceeded its Gaussian budget.');
    sp.set(x,y,z);ss.set(sx,sy,sz);sq.setFromEuler(new T.Euler(0,rotation,0));sc.set(color).convertLinearToSRGB();
    packed.pushSplat(sp,ss,sq,opacity,sc);splatCount++;
  }

  // Curving trunks, frond silhouettes, and small leaf Gaussians form one coherent canopy.
  function palm(x:number,z:number,height:number,lean:number){
    const direction=rand()*Math.PI*2;
    const curve=new T.CatmullRomCurve3([new T.Vector3(x,0,z),new T.Vector3(x+Math.cos(direction)*lean*.15,height*.35,z+Math.sin(direction)*lean*.15),new T.Vector3(x+Math.cos(direction)*lean*.5,height*.7,z+Math.sin(direction)*lean*.5),new T.Vector3(x+Math.cos(direction)*lean,height,z+Math.sin(direction)*lean)]);
    put(new T.TubeGeometry(curve,14,.16,7,false),trunk,new T.Vector3());
    const top=curve.getPoint(1);
    for(let k=0;k<12;k++){
      const angle=k*Math.PI/6+(rand()-.5)*.22,length=3.2+rand()*1.5;
      const vertices:number[]=[],uv:number[]=[],indices:number[]=[];
      for(let n=0;n<=14;n++){
        const t=n/14,r=t*length,width=Math.sin(Math.PI*t)*.37;
        const bend=.85*Math.sin(Math.PI*t)-t*t*1.9;
        for(const side of [-1,1]){const serration=n%2===0?.72:1;vertices.push(top.x+Math.cos(angle)*r+Math.cos(angle+Math.PI/2)*width*side*serration,top.y+bend,top.z+Math.sin(angle)*r+Math.sin(angle+Math.PI/2)*width*side*serration);uv.push((side+1)/2,t);}
        if(n<14){const a=n*2;indices.push(a,a+1,a+2,a+1,a+3,a+2);}
        if(n>1&&n<14)for(const side of [-1,1]){
          const leafLength=.28+Math.sin(Math.PI*t)*.45;
          const leafAngle=angle+side*.8;
          for(let j=0;j<4;j++)splat(top.x+Math.cos(angle)*r+Math.cos(leafAngle)*leafLength*j/3,top.y+bend-.015-j*.025,top.z+Math.sin(angle)*r+Math.sin(leafAngle)*leafLength*j/3,.075,.018,.18,j%2?0x627944:0x405e32,.8,-leafAngle);
        }
      }
      const geometry=new T.BufferGeometry();geometry.setAttribute('position',new T.Float32BufferAttribute(vertices,3));geometry.setAttribute('uv',new T.Float32BufferAttribute(uv,2));geometry.setIndex(indices);geometry.computeVertexNormals();put(geometry,k%3?green:lightGreen,new T.Vector3());
    }
    for(let j=0;j<4;j++)put(new T.SphereGeometry(.16,7,5),trunk,top.clone().add(new T.Vector3((rand()-.5)*.5,-.25,(rand()-.5)*.5)));
    // Conservative narrow trunk collider only; no collision inferred from foliage radiance.
    collider(x,z,.55,.55,height*.75);
  }
  green.side=T.DoubleSide;lightGreen.side=T.DoubleSide;
  for(let i=0;i<18;i++)palm(-112+i*7.4,-3.1+(i%2)*.45,7.2+rand()*4,1+rand()*1.6);
  for(const [x,z,h] of [[-70,32,9],[-47,45,10],[-19,39,8.7],[16,5,8],[13,48,9],[-79,6,10],[-95,43,8]] as const)palm(x,z,h,1.3+rand());

  // Dune grass uses sparse kernels and physical blades, with no screen facing sprites.
  for(let i=0;i<190;i++){
    const x=-110+rand()*127,z=49+rand()*35;
    for(let j=0;j<13;j++){
      const a=rand()*Math.PI*2,r=rand()*.65,h=.15+rand()*.4;
      splat(x+Math.cos(a)*r,h/2,z+Math.sin(a)*r,.035,h*.6,.035,rand()>.5?0x9a9a68:0x777c4b,.7);
    }
    if(i%2===0)bar(new T.Vector3(x,.02,z),new T.Vector3(x+.1,.43,z+.12),.013,seaGrass,4);
  }
  // Fine surface radiance and small wind swept ridges reinforce the sandy foreground.
  for(let i=0;i<8500;i++){
    const x=-112+rand()*132,z=-3+rand()*107;
    if(x>23)continue;
    const color=rand()>.55?0xd8c29d:rand()>.5?0xb8aa81:0xe3d1ac;
    splat(x,.005+rand()*.015,z,.12+rand()*.25,.006,.05+rand()*.12,color,.21,rand()*.4);
  }
  // A deliberately authored coral flare plume gives depth to the reference's red smoke motif.
  // It is static volumetric appearance; it does not claim a fluid simulation or observation.
  for(let i=0;i<210;i++){
    const t=rand(),spread=.25+t*2.5,x=5+t*14+(rand()-.5)*spread,y=5.15+t*4+(rand()-.5)*spread,z=23-t*1.9+(rand()-.5)*spread;
    splat(x,y,z,.32+t*.7,.35+t*.8,.35+t*.7,i%3===0?0xb73c45:0xd65b5e,.10+rand()*.09);
  }
  const splats=new SplatMesh({packedSplats:packed,raycastable:false,lod:false});splats.name='Authored coast appearance / no sensing';

  // Bollards, lamps and benches give the promenade scale and useful occluders.
  for(let x=-108;x<23;x+=10){
    box(2.5,.13,.48,x,.55,-4.05,wood);box(2.5,.48,.075,x,.83,-4.23,wood,new T.Euler(-.12,0,0));
    for(const dx of [-.9,.9])box(.055,.5,.055,x+dx,.28,-4.05,dark);
    bar(new T.Vector3(x+3,.2,-18.5),new T.Vector3(x+3,5.1,-18.5),.055,dark);
    box(.65,.15,.65,x+3,5.15,-18.5,ivory);
    for(const side of [-1,1])put(new T.CylinderGeometry(.1,.13,.7,8),concrete,new T.Vector3(x+side*2.4,.5,-4.4));
  }

  // Material batching keeps the architecture's draw cost bounded as visual detail grows.
  for(const [material,parts] of batches){
    const merged=mergeGeometries(parts,false);
    parts.forEach(g=>g.dispose());
    if(!merged)throw new Error('Authored coast geometry could not be batched.');
    const mesh=new T.Mesh(merged,material);mesh.castShadow=material!==sand&&material!==wetSand&&material!==promenade;mesh.receiveShadow=true;
    geometryResources.add(merged);staticMeshes.add(mesh);
  }
  batches.clear();

  const limbPairs=new Map<string,[T.Group,T.Group,T.Group,T.Group]>();
  const actorGroups=new Map<string,T.Group>();
  const skin=mat(0xad8060,.83),shirt1=mat(0xdcc7a4,.88),shirt2=mat(0x568e8a,.78),pants=mat(0x47585c,.92);
  function mesh(parent:T.Object3D,geometry:T.BufferGeometry,material:T.Material,x=0,y=0,z=0){
    geometryResources.add(geometry);const object=new T.Mesh(geometry,material);object.position.set(x,y,z);object.castShadow=object.receiveShadow=true;parent.add(object);return object;
  }
  function walker(id:string,shirt:T.Material){
    const group=new T.Group();group.name=id;group.userData.entityId=id;dynamicMeshes.add(group);actorGroups.set(id,group);
    mesh(group,new T.CapsuleGeometry(.18,.39,4,8),shirt,0,1.18,0);
    mesh(group,new T.SphereGeometry(.125,10,8),skin,0,1.64,.015);
    mesh(group,new T.CylinderGeometry(.16,.16,.055,12),ivory,0,1.74,0);
    const limbs:T.Group[]=[];
    for(const side of [-1,1]){
      const leg=new T.Group();leg.position.set(side*.11,.92,0);group.add(leg);mesh(leg,new T.CapsuleGeometry(.07,.58,3,7),pants,0,-.36,0);mesh(leg,new T.BoxGeometry(.15,.11,.26),dark,0,-.82,.055);limbs.push(leg);
    }
    for(const side of [-1,1]){
      const arm=new T.Group();arm.position.set(side*.23,1.39,0);group.add(arm);mesh(arm,new T.CapsuleGeometry(.055,.4,3,7),skin,0,-.25,0);limbs.push(arm);
    }
    limbPairs.set(id,limbs as [T.Group,T.Group,T.Group,T.Group]);
  }
  walker('coast-walker-1',shirt1);walker('coast-walker-2',shirt2);
  const vehicle=new T.Group();vehicle.name='coast-vehicle-1';vehicle.userData.entityId=vehicle.name;actorGroups.set(vehicle.name,vehicle);dynamicMeshes.add(vehicle);
  mesh(vehicle,new T.BoxGeometry(1.35,.36,2.45),teal,0,.48,0);
  mesh(vehicle,new T.BoxGeometry(1.22,.18,1.16),ivory,0,.74,-.31);
  mesh(vehicle,new T.BoxGeometry(1.36,.1,1.9),ivory,0,1.7,-.16);
  for(const x of [-.59,.59])for(const z of [-.92,.65])mesh(vehicle,new T.BoxGeometry(.055,.95,.055),white,x,1.2,z);
  for(const z of [-.6,.22]){mesh(vehicle,new T.BoxGeometry(1.04,.19,.5),dark,0,.86,z);mesh(vehicle,new T.BoxGeometry(1.04,.48,.12),dark,0,1.12,z-.22);}
  for(const x of [-.7,.7])for(const z of [-.78,.78]){const wheel=mesh(vehicle,new T.CylinderGeometry(.28,.28,.18,14),rubber,x,.29,z);wheel.rotation.z=Math.PI/2;}
  for(const x of [-.48,.48])mesh(vehicle,new T.SphereGeometry(.11,8,6),ivory,x,.6,1.23);
  mesh(vehicle,new T.BoxGeometry(.8,.32,.5),coral,0,.95,-1);

  function addSign(title:string,subtitle:string,x:number,y:number,z:number,w:number,h:number,bg:number,fg:number){
    const canvas=document.createElement('canvas');canvas.width=1024;canvas.height=256;const ctx=canvas.getContext('2d');if(!ctx)return;
    ctx.fillStyle=`#${bg.toString(16).padStart(6,'0')}`;ctx.fillRect(0,0,1024,256);ctx.fillStyle=`#${fg.toString(16).padStart(6,'0')}`;ctx.textAlign='center';ctx.font='600 88px sans-serif';ctx.fillText(title,512,116);ctx.font='24px sans-serif';ctx.fillText(subtitle,512,186);
    const texture=new T.CanvasTexture(canvas);texture.colorSpace=T.SRGBColorSpace;textures.add(texture);const material=new T.MeshStandardMaterial({map:texture,roughness:.9});materials.add(material);
    const geometry=new T.PlaneGeometry(w,h);geometryResources.add(geometry);const sign=new T.Mesh(geometry,material);sign.position.set(x,y,z);staticMeshes.add(sign);
  }

  const result:CoastalScene={staticMeshes,dynamicMeshes,splats,collisionBoxes,get splatCount(){return splatCount;},actorStates:coastalActorStates,
    update(timeSeconds){
      if(disposed)return;
      const t=Number.isFinite(timeSeconds)?Math.max(0,timeSeconds)%COAST_REPLAY_SECONDS:0;
      water.userData.clock.value=t;
      for(const state of coastalActorStates(t)){
        const group=actorGroups.get(state.id)!;group.position.fromArray(state.position);group.rotation.y=state.heading;
        const limbs=limbPairs.get(state.id);if(limbs){const stride=Math.sin(t*COAST_PHASE_RATE*84+(state.id.endsWith('2')?2:0))*.43;limbs[0].rotation.x=stride;limbs[1].rotation.x=-stride;limbs[2].rotation.x=-stride*.75;limbs[3].rotation.x=stride*.75;}
      }
    },
    dispose(){if(disposed)return;disposed=true;splats.removeFromParent();splats.dispose();geometryResources.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());textures.forEach(t=>t.dispose());staticMeshes.removeFromParent();dynamicMeshes.removeFromParent();staticMeshes.clear();dynamicMeshes.clear();},
  };
  result.update(0);return result;
}

function makeTexture(kind:'sand'|'wood'):T.CanvasTexture {
  const canvas=document.createElement('canvas');canvas.width=256;canvas.height=256;
  const ctx=canvas.getContext('2d');if(!ctx)throw new Error('Canvas texture initialization failed.');
  const image=ctx.createImageData(256,256);let seed=83291;
  for(let y=0;y<256;y++)for(let x=0;x<256;x++){
    seed=(Math.imul(seed,1664525)+1013904223)>>>0;const n=seed/4294967296;
    const grain=kind==='sand'?Math.sin(y*.3+Math.sin(x*.04)*3)*4+(n-.5)*15:Math.sin(x*.49+Math.sin(y*.027)*1.8)*12+(n-.5)*8;
    const value=205+grain,index=(y*256+x)*4;image.data[index]=value;image.data[index+1]=value;image.data[index+2]=value;image.data[index+3]=255;
  }
  ctx.putImageData(image,0,0);const texture=new T.CanvasTexture(canvas);texture.colorSpace=T.SRGBColorSpace;texture.wrapS=texture.wrapT=T.RepeatWrapping;texture.repeat.set(kind==='sand'?28:2,kind==='sand'?30:4);texture.anisotropy=4;return texture;
}

function createOcean():T.Mesh<T.PlaneGeometry,T.MeshStandardMaterial> {
  const geometry=new T.PlaneGeometry(225,350,110,90);geometry.rotateX(-Math.PI/2);geometry.translate(138,-.055,-10);
  const material=new T.MeshStandardMaterial({color:0x4c9eaa,roughness:.28,metalness:.24});
  const clock={value:0};
  material.onBeforeCompile=shader=>{
    shader.uniforms.coastTime=clock;
    shader.vertexShader='uniform float coastTime; varying vec3 vCoast;\n'+shader.vertexShader;
    shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>',`#include <begin_vertex>
      float shore = smoothstep(26.0, 52.0, position.x);
      float wave = sin(position.x*.48 + position.z*.07 + coastTime*.8)*.10 + sin(position.z*.36-position.x*.18+coastTime*1.1)*.055;
      transformed.y += wave*shore; vCoast=position;
    `);
    shader.fragmentShader='uniform float coastTime; varying vec3 vCoast;\n'+shader.fragmentShader;
    shader.fragmentShader=shader.fragmentShader.replace('#include <color_fragment>',`#include <color_fragment>
      float shore = smoothstep(27.0, 65.0, vCoast.x);
      vec3 shallow=vec3(.20,.61,.59); vec3 deep=vec3(.055,.27,.36);
      diffuseColor.rgb=mix(shallow,deep,shore);
      float crest=sin(vCoast.x*1.1+sin(vCoast.z*.19)*.6-coastTime*.9);
      float foam=smoothstep(.91,1.0,crest)*(1.0-smoothstep(27.0,39.0,vCoast.x));
      diffuseColor.rgb=mix(diffuseColor.rgb,vec3(.78,.86,.79),foam*.7);
      float ripple=sin(vCoast.x*4.0+coastTime*.7)*sin(vCoast.z*2.2+vCoast.x*.3-coastTime*.4);
      diffuseColor.rgb+=max(ripple,0.0)*.035;
    `);
  };
  material.customProgramCacheKey=()=> 'synthetic-coastal-water-v1';
  const mesh=new T.Mesh(geometry,material);mesh.receiveShadow=true;mesh.name='Synthetic animated ocean';mesh.userData.clock=clock;return mesh;
}
