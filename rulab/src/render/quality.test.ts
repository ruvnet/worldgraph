import {describe,it,expect} from 'vitest';
import {graphicsProfile,adaptiveRatio,clampExposure} from './quality';
describe('GPU budgets',()=>{
 it('gates expensive effects on floating point render capability',()=>{expect(graphicsProfile('quality',3,false)).toMatchObject({bloom:false,reflections:false,pixelRatio:1.85});expect(graphicsProfile('quality',2,true)).toMatchObject({bloom:true,reflections:true});});
 it('keeps performance mode free of postprocessing and shadows',()=>{expect(graphicsProfile('performance',3,true)).toMatchObject({shadows:false,bloom:false,reflections:false,antialias:false,pixelRatio:.85});});
 it('uses hysteresis, a floor, and a DPR cap for adaptation',()=>{expect(adaptiveRatio(1,40,1.25)).toBe(.85);expect(adaptiveRatio(1,25,1.25)).toBe(1);expect(adaptiveRatio(.65,100,1.25)).toBe(.65);expect(adaptiveRatio(1.25,12,1.25)).toBe(1.25);expect(adaptiveRatio(1,NaN,1.25)).toBe(1);});
 it('bounds device ratio and exposure at the renderer boundary',()=>{expect(graphicsProfile('auto',Infinity,true).pixelRatio).toBe(1);expect(clampExposure(Infinity)).toBe(1);expect(clampExposure(100)).toBe(2);expect(clampExposure(-3)).toBe(.4);});
});
