import type { Quality } from '../contracts';
export interface GraphicsProfile { pixelRatio:number; shadows:boolean; shadowSize:number; bloom:boolean; reflections:boolean; antialias:boolean }
/** Conservative initial auto mode; only measured frame windows may raise resolution. */
export function graphicsProfile(quality:Quality,dpr:number,hdr:boolean):GraphicsProfile {
  const safe=Number.isFinite(dpr)?Math.max(.5,Math.min(dpr,3)):1;
  return {pixelRatio:quality==='performance'?Math.min(safe,.85):Math.min(safe,quality==='quality'?1.85:1.25),
    shadows:quality!=='performance',shadowSize:quality==='quality'?2048:1024,
    bloom:quality==='quality'&&hdr,reflections:quality==='quality'&&hdr,antialias:quality!=='performance'};
}
export function adaptiveRatio(ratio:number,frameMs:number,cap:number):number {
  if(!Number.isFinite(frameMs)||frameMs<=0)return ratio;
  return Math.min(cap,Math.max(.65,frameMs>33.3?ratio-.15:frameMs<18?ratio+.1:ratio));
}
export function clampExposure(value:number):number{return Number.isFinite(value)?Math.max(.4,Math.min(value,2)):1;}
