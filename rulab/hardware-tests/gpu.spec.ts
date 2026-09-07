import {test,expect} from '@playwright/test';
import {readFile,writeFile} from 'node:fs/promises';
test('desktop GPU acceptance: 60 seconds, 300 samples, p95 at most 33.3 ms',async({page},info)=>{
 const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto('./');await expect(page.locator('#world')).toHaveAttribute('data-backend','webgl2');
 await expect(page.locator('#world')).toHaveAttribute('data-graphics',/"photographicMaps":6/);
 await expect(page.locator('#world')).toHaveAttribute('data-graphics',/photographic HDR/);
 const graphics=JSON.parse((await page.locator('#world').getAttribute('data-graphics'))!);
 expect(graphics.gpuRenderer,'Known software renderers do not qualify as a desktop GPU benchmark').not.toMatch(/swiftshader|llvmpipe|softpipe|software|basic render|lavapipe/i);
 expect(graphics.gpuRenderer.length,'Driver identity must be available').toBeGreaterThan(12);
 const quality=process.env.RULAB_GPU_QUALITY??'quality';expect(['quality','performance']).toContain(quality);
 await page.getByRole('button',{name:'Graphics settings',exact:true}).click();
 await page.getByLabel('Rendering quality',{exact:true}).selectOption(quality);
 await page.getByRole('button',{name:'Close graphics settings'}).click();
 // Warm shaders and texture uploads before taking a fresh, fixed-profile sample.
 await page.waitForTimeout(5000);
 await page.getByRole('button',{name:'Graphics settings',exact:true}).click();
 await page.getByRole('button',{name:'Start a fresh measurement'}).click();
 await page.getByRole('button',{name:'Close graphics settings'}).click();
 await page.getByRole('button',{name:'Play experiment',exact:true}).click();
 for(const shot of ['Robot','Flight','RF bay','Overview']){
  await page.getByRole('button',{name:shot,exact:true}).click();
  await page.waitForTimeout(15000);
 }
 await page.getByRole('button',{name:'Pause experiment',exact:true}).click();
 await page.screenshot({path:info.outputPath('gpu-scene.png'),fullPage:true});
 await page.getByRole('button',{name:'Graphics settings',exact:true}).click();
 const pending=page.waitForEvent('download');await page.getByRole('button',{name:'Export GPU evidence',exact:true}).click();
 const downloaded=await pending;const report=JSON.parse(await readFile((await downloaded.path())!,'utf8'));
 // Save failure evidence too. Browser-reported identity is not independent hardware attestation.
 report.benchmark={kind:'desktop-driver-reported',durationSeconds:60,minimumSamples:300,p95BudgetMs:33.3,quality};
 await writeFile(info.outputPath('gpu-evidence.json'),JSON.stringify(report,null,2));
 await info.attach('gpu-evidence',{body:JSON.stringify(report),contentType:'application/json'});
 expect(report.backend).toBe('webgl2');expect(report.frameSamples).toBeGreaterThanOrEqual(300);
 expect(report.metrics.graphics.quality).toBe(quality);
 expect(report.p95FrameMs,'Reduce quality or scene cost if the 30 FPS budget fails').toBeLessThanOrEqual(33.3);
 expect(errors).toEqual([]);
});
