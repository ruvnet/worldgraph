import * as T from 'three';

export type Position3=[number,number,number];
/** Authored room collision proxy. Not a certified robot navigation map. */
export function isCameraPositionAllowed([x,y,z]:Position3):boolean{
  if(![x,y,z].every(Number.isFinite)||x< -11.3||x>11.3||z< -16.3||z>16.3||y<.75||y>9.8)return false;
  if(x< -7.42&&y<8.7)return false;
  if(x>7.53&&z> -6.36&&z<.38&&y<4.82)return false;
  if(Math.hypot(x,z+2)<1.55&&y<3.3)return false;
  for(const [bx,bz]of [[-4,-5],[-4,4],[4,-7],[4,4]])if(Math.abs(x-bx)<1.38&&Math.abs(z-bz)<.85&&y<1.5)return false;
  return true;
}
export function constrainMovement(from:Position3,to:Position3):Position3{
  // Subdivide long moves to prevent tunnelling through a thin obstacle.
  if(![...from,...to].every(Number.isFinite))return [...from];
  const distance=Math.hypot(...to.map((v,i)=>v-from[i]));const boundedDistance=Math.min(30,distance);const steps=Math.max(1,Math.ceil(boundedDistance/.15));
  const scale=distance>30?30/distance:1;const step=to.map((v,i)=>(v-from[i])*scale/steps);const next:Position3=[...from];
  for(let n=0;n<steps;n++)for(let axis=0;axis<3;axis++){const proposed:Position3=[...next];proposed[axis]+=step[axis];if(isCameraPositionAllowed(proposed))next[axis]=proposed[axis];}
  return next;
}
export interface NavigatorControls {update(dt:number):void;move(forward:number,right:number,up?:number):void;lookAt(position:Position3,target:Position3):void;setCollisionEnabled(enabled:boolean):void;dispose():void}
export function makeControls(canvas:HTMLCanvasElement,camera:T.PerspectiveCamera,onClick:(x:number,y:number)=>void):NavigatorControls{
  const keys=new Set<string>(),pointers=new Map<number,{x:number,y:number}>();let start={x:0,y:0},moved=false;
  let yaw=camera.rotation.y,pitch=camera.rotation.x,roll=0;let collisionEnabled=true;const previousTouchAction=canvas.style.touchAction;canvas.style.touchAction='none';
  const previousTabIndex=canvas.tabIndex;canvas.tabIndex=0;
  const direction=new T.Vector3(),rightward=new T.Vector3(),upward=new T.Vector3(),next=new T.Vector3();
  function move(forward:number,right:number,up=0){
    if(![forward,right,up].every(Number.isFinite))return;
    direction.set(0,0,-1).applyQuaternion(camera.quaternion);rightward.set(1,0,0).applyQuaternion(camera.quaternion);upward.set(0,1,0).applyQuaternion(camera.quaternion);
    next.copy(camera.position).addScaledVector(direction,forward).addScaledVector(rightward,right).addScaledVector(upward,up);
    if(collisionEnabled)camera.position.fromArray(constrainMovement(camera.position.toArray() as Position3,next.toArray() as Position3));
    else camera.position.copy(next.clamp(new T.Vector3(-20,.3,-25),new T.Vector3(20,18,25)));
  }
  function apply(){pitch=T.MathUtils.clamp(pitch,-1.45,1.45);camera.rotation.set(pitch,yaw,roll,'YXZ');}
  function pointerDown(e:PointerEvent){if(e.button!==0&&e.pointerType==='mouse')return;canvas.focus({preventScroll:true});canvas.setPointerCapture(e.pointerId);if(!pointers.size){start={x:e.clientX,y:e.clientY};moved=false;}else moved=true;pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});}
  function pointerMove(e:PointerEvent){const p=pointers.get(e.pointerId);if(!p)return;
    if(Math.hypot(e.clientX-start.x,e.clientY-start.y)>6)moved=true;
    if(pointers.size===1){yaw-=(e.clientX-p.x)*.003;pitch-=(e.clientY-p.y)*.003;apply();}
    else{const other=[...pointers.entries()].find(([id])=>id!==e.pointerId)?.[1];if(other){const before=Math.hypot(p.x-other.x,p.y-other.y);const after=Math.hypot(e.clientX-other.x,e.clientY-other.y);if(before>4&&after>4){camera.fov=T.MathUtils.clamp(camera.fov*before/after,35,95);camera.updateProjectionMatrix();}move(0,-(e.clientX-p.x)*.008,(e.clientY-p.y)*.008);}}
    pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
  }
  function pointerUp(e:PointerEvent){if(!pointers.has(e.pointerId))return;pointers.delete(e.pointerId);if(canvas.hasPointerCapture(e.pointerId))canvas.releasePointerCapture(e.pointerId);if(!pointers.size&&!moved)onClick(e.clientX,e.clientY);}
  function pointerCancel(e:PointerEvent){pointers.delete(e.pointerId);moved=true;}
  function wheel(e:WheelEvent){e.preventDefault();camera.fov=T.MathUtils.clamp(camera.fov+e.deltaY*.027,35,95);camera.updateProjectionMatrix();}
  const motionKeys=new Set(['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','KeyQ','KeyE','KeyZ','KeyX','ShiftLeft','ShiftRight']);
  function keyDown(e:KeyboardEvent){const target=e.target as HTMLElement;if(target!==canvas&&target!==document.body)return;if(e.metaKey||e.altKey||e.ctrlKey||!motionKeys.has(e.code))return;e.preventDefault();keys.add(e.code);}
  function keyUp(e:KeyboardEvent){keys.delete(e.code);}
  function blur(){keys.clear();pointers.clear();moved=true;}
  canvas.addEventListener('pointerdown',pointerDown);canvas.addEventListener('pointermove',pointerMove);canvas.addEventListener('pointerup',pointerUp);canvas.addEventListener('pointercancel',pointerCancel);canvas.addEventListener('wheel',wheel,{passive:false});
  window.addEventListener('keydown',keyDown);window.addEventListener('keyup',keyUp);window.addEventListener('blur',blur);document.addEventListener('visibilitychange',blur);
  return {move,setCollisionEnabled(enabled){collisionEnabled=enabled;},update(dt){const speed=Math.min(.05,Math.max(0,dt))*(keys.has('ShiftLeft')||keys.has('ShiftRight')?5:2.6);const f=Number(keys.has('KeyW')||keys.has('ArrowUp'))-Number(keys.has('KeyS')||keys.has('ArrowDown'));const r=Number(keys.has('KeyD')||keys.has('ArrowRight'))-Number(keys.has('KeyA')||keys.has('ArrowLeft'));const u=Number(keys.has('KeyE'))-Number(keys.has('KeyQ'));const norm=Math.max(1,Math.hypot(f,r,u));if(f||r||u)move(f*speed/norm,r*speed/norm,u*speed/norm);const rollDelta=Number(keys.has('KeyZ'))-Number(keys.has('KeyX'));if(rollDelta){roll+=rollDelta*speed*.32;apply();}},
    lookAt(position,target){camera.position.fromArray(position);camera.lookAt(new T.Vector3(...target));camera.rotation.order='YXZ';yaw=camera.rotation.y;pitch=camera.rotation.x;roll=0;apply();},
    dispose(){canvas.removeEventListener('pointerdown',pointerDown);canvas.removeEventListener('pointermove',pointerMove);canvas.removeEventListener('pointerup',pointerUp);canvas.removeEventListener('pointercancel',pointerCancel);canvas.removeEventListener('wheel',wheel);window.removeEventListener('keydown',keyDown);window.removeEventListener('keyup',keyUp);window.removeEventListener('blur',blur);document.removeEventListener('visibilitychange',blur);canvas.style.touchAction=previousTouchAction;canvas.tabIndex=previousTabIndex;blur();}};
}
