import {describe,it,expect} from 'vitest';
import {constrainMovement,isCameraPositionAllowed} from './controls';

describe('authored navigation boundaries',()=>{
  it('allows the overview camera and an unobstructed route through the aisle',()=>{
    expect(isCameraPositionAllowed([7,3,14])).toBe(true);
    expect(constrainMovement([3,3,12],[3,3,8])[2]).toBeCloseTo(8);
  });
  it('stops long movements at the solid RF room and does not tunnel',()=>{
    const p=constrainMovement([3,2,-3],[11,2,-3]);expect(p[0]).toBeLessThanOrEqual(7.53);expect(p[0]).toBeGreaterThan(7.2);
  });
  it('prevents entering the robot keepout and retains sliding on the free axis',()=>{
    const p=constrainMovement([2,2,-2],[0,2,-2]);expect(Math.hypot(p[0],p[2]+2)).toBeGreaterThanOrEqual(1.55);
    const slide=constrainMovement([7.5,2,-3],[8.5,3,-3]);expect(slide[0]).toBeLessThanOrEqual(7.53);expect(slide[1]).toBeCloseTo(3);
  });
  it('allows movement above the chamber while retaining ceiling bounds',()=>{
    expect(constrainMovement([7,5,-3],[9,5,-3])[0]).toBeCloseTo(9);
    expect(constrainMovement([0,8,10],[0,15,10])[1]).toBeLessThanOrEqual(9.8);
  });
  it('rejects nonfinite positions and stays in bounds under repeated input',()=>{
    expect(isCameraPositionAllowed([NaN,2,2])).toBe(false);let p:[number,number,number]=[7,3,14];
    for(let i=0;i<400;i++){p=constrainMovement(p,[p[0]+Math.sin(i)*.7,p[1]+Math.cos(i*.7)*.2,p[2]+Math.cos(i)*.7]);expect(isCameraPositionAllowed(p)).toBe(true);}
  });
});
