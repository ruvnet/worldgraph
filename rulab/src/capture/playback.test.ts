import { describe, expect, it } from 'vitest';
import { CapturePlayback, capturePreviewTransform } from './playback';
import type { CapturePlaybackState } from './types';
function deferred<T>() { let resolve!:(value:T)=>void, reject!:(reason:Error)=>void; const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject}; }
async function tick(){for(let i=0;i<6;i++)await Promise.resolve();}
type Asset={id:number};
function rig(){
  const requests:Array<{index:number;signal:AbortSignal;result:ReturnType<typeof deferred<Asset>>}>=[];
  const displayed:number[]=[],disposed:number[]=[],states:CapturePlaybackState[]=[];let active=0,maximum=0;
  const player=new CapturePlayback<Asset>({frames:[{time:0},{time:1},{time:2},{time:3}],duration:4,select:t=>Math.min(3,Math.floor(t)),
    decode(index,signal){active++;maximum=Math.max(maximum,active);const result=deferred<Asset>();requests.push({index,signal,result});return result.promise.finally(()=>{active--;});},
    display(asset){displayed.push(asset.id);},disposeAsset(asset){disposed.push(asset.id);},onState:s=>states.push(s)});
  return {player,requests,displayed,disposed,states,get maximum(){return maximum;}};
}
describe('bounded capture playback',()=>{
  it('avoids repeated decode within the displayed sample interval',async()=>{
    const r=rig();r.player.seek(0);await tick();r.requests[0]!.result.resolve({id:0});await r.player.settled();r.player.seek(.6);r.player.seek(.99);await tick();expect(r.requests).toHaveLength(1);expect(r.player.getState()).toEqual({requestedTime:.99,displayedIndex:0,displayedTime:0,loading:false,error:null});
  });
  it('decodes one sample at once and discards obsolete results',async()=>{
    const r=rig();r.player.seek(0);await tick();r.player.seek(1.1);r.player.seek(3.1);expect(r.requests).toHaveLength(1);r.requests[0]!.result.resolve({id:0});await tick();expect(r.disposed).toEqual([0]);expect(r.displayed).toEqual([]);expect(r.requests.map(x=>x.index)).toEqual([0,3]);r.requests[1]!.result.resolve({id:3});await r.player.settled();expect(r.displayed).toEqual([3]);expect(r.maximum).toBe(1);
  });
  it('holds the last good scene through failure until explicit retry',async()=>{
    const r=rig();r.player.seek(0);await tick();r.requests[0]!.result.resolve({id:0});await r.player.settled();r.player.seek(1.2);await tick();expect(r.player.getState().displayedTime).toBe(0);expect(r.player.getState().loading).toBe(true);expect(r.disposed).toEqual([]);r.requests[1]!.result.reject(new Error('Hash mismatch'));await r.player.settled();expect(r.player.getState().error).toBe('Hash mismatch');expect(r.displayed).toEqual([0]);r.player.seek(1.8);r.player.seek(1.9);await tick();expect(r.requests).toHaveLength(2);r.player.retry();await tick();expect(r.requests).toHaveLength(3);r.requests[2]!.result.resolve({id:1});await r.player.settled();expect(r.disposed).toEqual([0]);expect(r.player.getState().displayedIndex).toBe(1);expect(r.player.getState().error).toBeNull();
  });
  it('changing sample clears failure without retrying the failed sample',async()=>{
    const r=rig();r.player.seek(1);await tick();r.requests[0]!.result.reject(new Error('Bad frame'));await r.player.settled();r.player.seek(2);await tick();expect(r.requests.map(x=>x.index)).toEqual([1,2]);r.requests[1]!.result.resolve({id:2});await r.player.settled();expect(r.player.getState().error).toBeNull();
  });
  it('seeking to displayed frame makes a pending replacement stale',async()=>{
    const r=rig();r.player.seek(0);await tick();r.requests[0]!.result.resolve({id:0});await r.player.settled();r.player.seek(2);await tick();r.player.seek(.2);expect(r.player.getState().loading).toBe(false);r.requests[1]!.result.resolve({id:2});await r.player.settled();expect(r.displayed).toEqual([0]);expect(r.disposed).toEqual([2]);expect(r.requests).toHaveLength(2);
  });
  it('dispose releases current and late assets without late callbacks',async()=>{
    const r=rig();r.player.seek(0);await tick();r.requests[0]!.result.resolve({id:0});await r.player.settled();r.player.seek(1);await tick();const callbacks=r.states.length;r.player.dispose();r.player.dispose();expect(r.requests[1]!.signal.aborted).toBe(true);r.requests[1]!.result.resolve({id:1});await r.player.settled();expect(r.disposed).toEqual([0,1]);expect(r.displayed).toEqual([0]);expect(r.states).toHaveLength(callbacks);r.player.seek(3);await tick();expect(r.requests).toHaveLength(2);
  });
  it('suspension holds current scene and cancels pending replacement',async()=>{
    const r=rig();r.player.seek(0);await tick();r.requests[0]!.result.resolve({id:0});await r.player.settled();r.player.seek(1);await tick();r.player.suspend();r.requests[1]!.result.resolve({id:1});await r.player.settled();expect(r.disposed).toEqual([1]);expect(r.player.displayedAsset?.id).toBe(0);r.player.seek(2);await tick();expect(r.requests).toHaveLength(2);r.player.resume();await tick();expect(r.requests[2]!.index).toBe(2);r.requests[2]!.result.resolve({id:2});await r.player.settled();expect(r.disposed).toEqual([1,0]);
  });
  it('failed display commit disposes candidate and retains old asset',async()=>{
    const disposed:number[]=[];const player=new CapturePlayback<Asset>({frames:[{time:0},{time:1}],duration:2,select:t=>Math.min(1,Math.floor(t)),decode:async i=>({id:i}),display:a=>{if(a.id===1)throw new Error('Commit failed');},disposeAsset:a=>{disposed.push(a.id);}});player.seek(0);await player.settled();player.seek(1);await player.settled();expect(player.displayedAsset?.id).toBe(0);expect(disposed).toEqual([1]);expect(player.getState().error).toBe('Commit failed');
  });
  it('clamps endpoints and rejects nonfinite seek requests',async()=>{
    const r=rig();expect(()=>r.player.seek(NaN)).toThrow('finite');r.player.seek(-20);await tick();r.requests[0]!.result.resolve({id:0});await r.player.settled();expect(r.player.getState().requestedTime).toBe(0);r.player.seek(99);await tick();expect(r.requests[1]!.index).toBe(3);r.requests[1]!.result.resolve({id:3});await r.player.settled();expect(r.player.getState().requestedTime).toBe(4);
  });
});


describe('fixed capture preview transform',()=>{
  it('rejects tiny extents before division can create Infinity',()=>{expect(()=>capturePreviewTransform({min:[0,0,0],max:[1e-310,1e-310,1e-310]})).toThrow('one centimetre');});
  it('uses declared shared bounds independently of sample geometry',()=>{const transform=capturePreviewTransform({min:[-5,-.2,-4],max:[5,4.5,4]});expect(transform.scale).toBe(1.8);expect(transform.position[0]).toBeCloseTo(0);expect(transform.position[1]).toBeCloseTo(.36);expect(transform.position[2]).toBeCloseTo(0);expect([...transform.position,transform.scale].every(Number.isFinite)).toBe(true);});
  it('rejects inverted, nonfinite and overflowed extents',()=>{expect(()=>capturePreviewTransform({min:[0,0,0],max:[0,1,1]})).toThrow('positive extents');expect(()=>capturePreviewTransform({min:[-Number.MAX_VALUE,0,0],max:[Number.MAX_VALUE,1,1]})).toThrow('finite');expect(()=>capturePreviewTransform({min:[0,0,0],max:[NaN,1,1]})).toThrow('finite');});
});
