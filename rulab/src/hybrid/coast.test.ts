import {describe,expect,it} from 'vitest';
import {coastalActorStates,COAST_REPLAY_SECONDS} from './coast';

describe('authored coastal actor replay',()=>{
  it('restores identical identities and poses after seeking away and back',()=>{
    const before=coastalActorStates(23.5);
    coastalActorStates(99.25);
    expect(coastalActorStates(23.5)).toEqual(before);
    expect(before.map(actor=>actor.id)).toEqual(['coast-walker-1','coast-walker-2','coast-vehicle-1']);
  });
  it('keeps continuous trajectories inside the promenade and uses finite headings',()=>{
    for(let t=0;t<=120;t+=.25){
      const frame=coastalActorStates(t),next=coastalActorStates(t+.016);
      frame.forEach((actor,index)=>{
        const [x,y,z]=actor.position;
        // Promenade is x[-124,28], z[-19,-5]; leave clearance before ocean at x25.5.
        expect(x).toBeGreaterThanOrEqual(-110);expect(x).toBeLessThanOrEqual(20);
        expect(y).toBeGreaterThanOrEqual(.2);expect(y).toBeLessThan(.3);
        expect(z).toBeGreaterThanOrEqual(-15.5);expect(z).toBeLessThanOrEqual(-5.9);
        expect(Number.isFinite(actor.heading)).toBe(true);expect(Math.abs(actor.heading)).toBeLessThanOrEqual(Math.PI);
        // A 16 ms advance must not teleport an actor or change its identity.
        const b=next[index];expect(b.id).toBe(actor.id);
        expect(Math.hypot(...actor.position.map((value,axis)=>value-b.position[axis]))).toBeLessThan(.06);
      });
    }
  });
  it('loops after 120 seconds without a position or orientation jump',()=>{
    expect(coastalActorStates(COAST_REPLAY_SECONDS)).toEqual(coastalActorStates(0));
    const before=coastalActorStates(COAST_REPLAY_SECONDS-.016),after=coastalActorStates(.016);
    before.forEach((actor,index)=>{
      const next=after[index];
      expect(Math.hypot(...actor.position.map((value,axis)=>value-next.position[axis]))).toBeLessThan(.11);
      // Compare heading vectors rather than angles at the equivalent +pi/-pi boundary.
      expect(Math.hypot(Math.sin(actor.heading)-Math.sin(next.heading),Math.cos(actor.heading)-Math.cos(next.heading))).toBeLessThan(.01);
    });
  });
  it('normalizes invalid display clocks to the deterministic start pose',()=>{
    for(const time of [NaN,Infinity,-Infinity,-1])expect(coastalActorStates(time)).toEqual(coastalActorStates(0));
  });
});
