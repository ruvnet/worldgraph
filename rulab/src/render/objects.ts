import * as T from 'three';
import { SplatMesh, PackedSplats } from '@sparkjsdev/spark';
import type { WorldFrame } from '../contracts';
import { disposeGroup } from './architecture';

export interface SceneEntities {root:T.Group;pickables:T.Object3D[];update(frame:WorldFrame):void;setGraph(visible:boolean):void;dispose():void;splatCount:number}
export function makeEntities():SceneEntities{
  const root=new T.Group(),pickables:T.Object3D[]=[];
  const white=new T.MeshStandardMaterial({color:0xe0ddd2,metalness:.42,roughness:.26});
  const metal=new T.MeshStandardMaterial({color:0x7c8589,metalness:.85,roughness:.2});
  const dark=new T.MeshStandardMaterial({color:0x172026,metalness:.52,roughness:.34});
  const rubber=new T.MeshStandardMaterial({color:0x101315,roughness:.9});
  const cyan=new T.MeshBasicMaterial({color:0x90e8db});
  const amber=new T.MeshBasicMaterial({color:0xf6c574});
  const graphMaterial=new T.MeshBasicMaterial({color:0xa4efdd,transparent:true,opacity:.68,depthTest:false});
  const transforms=new Map<string,T.Group>();const splats:SplatMesh[]=[];
  function box(parent:T.Object3D,w:number,h:number,d:number,x:number,y:number,z:number,m:T.Material=white){const o=new T.Mesh(new T.BoxGeometry(w,h,d),m);o.position.set(x,y,z);o.castShadow=o.receiveShadow=true;parent.add(o);return o;}
  function cylinder(parent:T.Object3D,r:number,h:number,x:number,y:number,z:number,m:T.Material=white){const o=new T.Mesh(new T.CylinderGeometry(r,r,h,24),m);o.position.set(x,y,z);o.castShadow=o.receiveShadow=true;parent.add(o);return o;}
  function group(id:string):T.Group{const g=new T.Group();g.name=id;g.userData.entityId=id;root.add(g);transforms.set(id,g);pickables.push(g);return g;}
  // A six-part articulated manipulator, represented by separate transform groups.
  const robot=group('robot-1');robot.scale.setScalar(.7);box(robot,1.1,.14,1.1,0,.09,0,dark);cylinder(robot,.36,.7,0,.51,0,metal);
  const base=new T.Group();base.position.y=.88;robot.add(base);cylinder(base,.32,.25,0,.1,0,white);
  const shoulder=new T.Group();shoulder.position.y=.31;base.add(shoulder);
  const shoulderJoint=cylinder(shoulder,.29,.43,0,0,0,dark);shoulderJoint.rotation.z=Math.PI/2;
  box(shoulder,.32,1.52,.4,0,.79,0,white);box(shoulder,.07,1.16,.42,.18,.8,0,metal);
  const elbow=new T.Group();elbow.position.y=1.6;shoulder.add(elbow);
  const elbowJoint=cylinder(elbow,.25,.43,0,0,0,dark);elbowJoint.rotation.z=Math.PI/2;
  box(elbow,.25,1.27,.33,0,.66,0,white);box(elbow,.05,.99,.37,.14,.66,0,metal);
  const wrist=new T.Group();wrist.position.y=1.38;elbow.add(wrist);cylinder(wrist,.19,.3,0,.07,0,metal);
  box(wrist,.38,.16,.25,0,.25,0,dark);box(wrist,.055,.25,.13,-.17,.44,0,metal);box(wrist,.055,.25,.13,.17,.44,0,metal);
  cylinder(base,.12,.03,.05,.24,.16,cyan);
  // A little curved cable is rigidly attached to each link, preserving replay.
  for(const [node,len]of [[shoulder,1.4],[elbow,1.15]] as const){const curve=new T.CatmullRomCurve3([new T.Vector3(-.2,.05,0),new T.Vector3(-.34,len*.5,.08),new T.Vector3(-.18,len,.05)]);node.add(new T.Mesh(new T.TubeGeometry(curve,16,.025,6,false),rubber));}

  const drone=group('drone-1');drone.scale.setScalar(.31);box(drone,.61,.22,.48,0,0,0,dark);box(drone,.45,.045,.38,0,.14,0,white);
  const rotors:T.Group[]=[];
  for(const x of [-.72,.72])for(const z of [-.72,.72]){
    const arm=new T.Mesh(new T.CylinderGeometry(.035,.035,Math.hypot(x,z),8),metal);arm.position.set(x/2,0,z/2);arm.quaternion.setFromUnitVectors(new T.Vector3(0,1,0),new T.Vector3(x,0,z).normalize());drone.add(arm);
    cylinder(drone,.09,.15,x,.05,z,dark);const rotor=new T.Group();rotor.position.set(x,.15,z);drone.add(rotor);rotors.push(rotor);
    box(rotor,.71,.012,.055,0,0,0,rubber);box(rotor,.055,.013,.71,0,0,0,rubber);
    const guard=new T.Mesh(new T.TorusGeometry(.39,.011,5,28),metal);guard.rotation.x=Math.PI/2;guard.position.set(x,.15,z);drone.add(guard);
    box(drone,.02,.27,.02,x*.44,-.23,z*.44,metal);
  }
  const cameraBall=new T.Mesh(new T.SphereGeometry(.12,16,10),metal);cameraBall.position.set(0,-.24,.13);drone.add(cameraBall);box(drone,.08,.06,.02,0,-.24,.242,cyan);
  const amr=group('amr-1');amr.scale.setScalar(.75);box(amr,.88,.26,1.08,0,.34,0,dark);box(amr,.8,.11,.98,0,.53,0,white);
  for(const x of [-.46,.46])for(const z of [-.34,.34]){const wheel=cylinder(amr,.16,.11,x,.19,z,rubber);wheel.rotation.z=Math.PI/2;}
  box(amr,.63,.035,.02,0,.36,.552,cyan);box(amr,.63,.035,.02,0,.36,-.552,amber);
  cylinder(amr,.1,.14,0,.65,0,dark);cylinder(amr,.103,.022,0,.68,0,cyan);
  box(amr,.62,.15,.6,0,.69,-.14,metal);for(const x of [-.2,.2])box(amr,.04,.14,.37,x,.835,-.14,dark);
  const door=group('rf-door');const hinge=new T.Group();hinge.position.set(-1.3,0,-1.5);door.add(hinge);
  box(hinge,.14,3.45,3,0,1.74,1.5,metal);box(hinge,.035,1,.76,-.091,2.45,1.35,dark);
  box(hinge,.05,.95,.71,-.12,2.45,1.35,new T.MeshPhysicalMaterial({color:0x7e9498,metalness:.3,roughness:.12}));
  for(const y of [.28,1.5,2.8])cylinder(hinge,.085,.3,0,y,0,metal);
  box(hinge,.24,.5,.07,-.2,1.48,2.72,metal);
  for(const id of ['sensor-1','sensor-2']){const sensor=group(id);box(sensor,.18,.14,.12,0,0,0,white);box(sensor,.055,.045,.014,0,.012,.07,cyan);const cone=new T.Mesh(new T.ConeGeometry(.32,.58,24,1,true),new T.MeshBasicMaterial({color:0x70bba6,transparent:true,opacity:.055,depthWrite:false,side:T.DoubleSide}));cone.rotation.x=Math.PI;cone.position.y=-.36;sensor.add(cone);}

  // Rigid local Gaussians decorate the AMR cargo and articulated arm links.
  // These are anisotropic 3D kernels, not point sprites, and inherit joint poses.
  function gaussianBox(node:T.Object3D,center:T.Vector3,extent:T.Vector3,color:number){
    const packed=new PackedSplats({maxSplats:256});const q=new T.Quaternion(),c=new T.Color(color).convertLinearToSRGB(),s=new T.Vector3(.055,.045,.012);
    for(let x=-extent.x/2;x<=extent.x/2;x+=.085)for(let y=-extent.y/2;y<=extent.y/2;y+=.08){packed.pushSplat(new T.Vector3(center.x+x,center.y+y,center.z+extent.z/2),s,q,.84,c);}
    const mesh=new SplatMesh({packedSplats:packed,raycastable:false});node.add(mesh);splats.push(mesh);
  }
  gaussianBox(shoulder,new T.Vector3(0,.75,.02),new T.Vector3(.32,1.42,.4),0xdad4c6);
  gaussianBox(elbow,new T.Vector3(0,.66,.02),new T.Vector3(.25,1.21,.34),0xdad4c6);
  gaussianBox(amr,new T.Vector3(0,.7,-.12),new T.Vector3(.61,.14,.61),0x8c9596);
  const graph=new T.Group();root.add(graph);graph.visible=false;
  const nodes=new Map<string,T.Mesh>();for(const id of transforms.keys()){const dot=new T.Mesh(new T.SphereGeometry(.16,16,12),graphMaterial);dot.renderOrder=100;dot.userData.entityId=id;graph.add(dot);nodes.set(id,dot);pickables.push(dot);}
  const linesGeometry=new T.BufferGeometry();const lines=new T.LineSegments(linesGeometry,new T.LineBasicMaterial({color:0x89c7b3,transparent:true,opacity:.45,depthTest:false}));graph.add(lines);
  const trailPoints:T.Vector3[]=[];for(let i=0;i<=100;i++){const a=i/100*Math.PI*2;trailPoints.push(new T.Vector3(Math.sin(a)*3,4.8,-Math.cos(a)*2));}const droneTrail=new T.Line(new T.BufferGeometry().setFromPoints(trailPoints),new T.LineDashedMaterial({color:0x90e8db,dashSize:.15,gapSize:.12,transparent:true,opacity:.4}));droneTrail.computeLineDistances();graph.add(droneTrail);
  let scenario='';const modular=new T.Group();root.add(modular);
  function setScenario(next:string){if(next===scenario)return;scenario=next;modular.traverse(o=>{if(o instanceof T.Mesh)o.geometry.dispose();});modular.clear();if(next==='robotics')return;
    for(const z of [-9,2,11]){const g=new T.Group();g.position.set(4.7,0,z);modular.add(g);box(g,2.6,.08,3.7,0,.08,0,metal);box(g,.1,2.7,3.7,1.3,1.4,0,white);box(g,2.6,2.7,.1,0,1.4,-1.85,white);box(g,2.6,.1,3.7,0,2.8,0,metal);box(g,2.4,.035,.055,0,2.71,-1.71,amber);box(g,1.12,.2,2.2,0,.62,.1,white);box(g,1.12,.48,.16,0,.82,-.94,dark);box(g,.9,.13,.35,0,.78,-.56,white);if(next==='healthcare'){box(g,.08,1.4,.08,-1,.7,.8,metal);box(g,.42,.35,.04,-1,1.5,.8,dark);}}}
  return {root,pickables,get splatCount(){return splats.reduce((n,s)=>n+s.numSplats,0);},setGraph(v){graph.visible=v;},
    update(frame){setScenario(frame.scenario);for(const e of frame.entities){const g=transforms.get(e.id);if(!g)continue;g.position.set(e.position[0],e.position[2],-e.position[1]);g.rotation.y=e.yaw+Math.PI/2; // model front +Z -> ENU East at yaw=0
      if(e.id==='robot-1'){g.rotation.y=e.yaw;base.rotation.y=e.joints[0]??0;shoulder.rotation.z=e.joints[1]??.4;elbow.rotation.z=e.joints[2]??-1.2;wrist.rotation.set(e.joints[4]??0,e.joints[3]??0,e.joints[5]??0);}
      if(e.id==='rf-door'){g.rotation.y=0;hinge.rotation.y=e.joints[0]??0;}
      if(e.kind==='sensor')g.rotation.y=0;
      if(e.id==='drone-1')rotors.forEach((r,i)=>{r.rotation.y=(e.joints[0]??0)*(i%2?1:-1);});
      const n=nodes.get(e.id);if(n){n.position.copy(g.position);if(e.kind==='robot')n.position.y+=1.5;if(e.kind==='amr')n.position.y+=.8;if(e.kind==='door')n.position.y+=2;}
    }
    const points:number[]=[];const anchors=[...nodes.values()];for(let i=1;i<anchors.length;i++){points.push(...anchors[0].position.toArray(),...anchors[i].position.toArray());}linesGeometry.setAttribute('position',new T.Float32BufferAttribute(points,3));linesGeometry.computeBoundingSphere();
  },dispose(){splats.forEach(s=>s.dispose());disposeGroup(root);}};
}
