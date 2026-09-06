import {test,expect,type Page} from '@playwright/test';
import {readFile} from 'node:fs/promises';
async function ready(page:Page){await page.goto('./');await expect(page.locator('#world')).toHaveAttribute('data-backend','webgl2');await expect(page.locator('#graph-status')).toHaveText('Rust graph · WebAssembly');await expect(page.locator('#graph-count')).toHaveText('14');await expect.poll(async()=>Number(await page.locator('#world').getAttribute('data-frame-samples'))).toBeGreaterThan(2);}
async function seek(page:Page,time:number){await page.getByRole('slider',{name:'Experiment time'}).evaluate((element,value)=>{(element as HTMLInputElement).value=String(value);element.dispatchEvent(new Event('input',{bubbles:true}));},time);await expect(page.locator('#graph-count')).toHaveAttribute('data-time',String(time));await expect(page.locator('#time')).toHaveText(`${Math.floor(time/60).toString().padStart(2,'0')}:${(time%60).toFixed(1).padStart(4,'0')}`);}
async function inspector(page:Page){if(await page.getByRole('button',{name:'Toggle world inspector'}).getAttribute('aria-expanded')!=='true')await page.getByRole('button',{name:'Toggle world inspector'}).click();}
async function graphJson(page:Page,seekBeforeExport?:number){await page.getByRole('button',{name:'About this world'}).click();const wait=page.waitForEvent('download');if(seekBeforeExport===undefined)await page.getByRole('button',{name:'Export WorldGraph snapshot'}).click();else await page.locator('#export-graph').evaluate((button,time)=>{const slider=document.querySelector<HTMLInputElement>('#timeline')!;slider.value=String(time);slider.dispatchEvent(new Event('input',{bubbles:true}));(button as HTMLButtonElement).click();},seekBeforeExport);const file=await wait;const data=await readFile((await file.path())!,'utf8');await page.getByRole('button',{name:'Close information'}).click();return data;}

test('renders real Gaussians with independent navigation and a stable WASM graph',async({page},info)=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await ready(page);
  expect(Number(await page.locator('#world').getAttribute('data-splats'))).toBeGreaterThan(42_000);
  expect(Number(await page.locator('#world').getAttribute('data-draw-calls'))).toBeGreaterThan(0);
  await expect(page.locator('#render-notice')).toBeHidden();
  await page.screenshot({path:info.outputPath('rulab-world.png'),fullPage:true});
  const initial=await page.locator('#world').getAttribute('data-camera');
  if(info.project.name.startsWith('mobile'))await page.getByRole('button',{name:'Move forward',exact:true}).click();
  else{await page.locator('#world').focus();await page.keyboard.down('w');}
  await expect(page.locator('#world')).not.toHaveAttribute('data-camera',initial!);await page.keyboard.up('w');
  const before=await page.locator('#world').getAttribute('data-camera');
  await page.getByRole('button',{name:'Robot',exact:true}).click();
  await expect(page.locator('#world')).not.toHaveAttribute('data-camera',before!);
  await expect(page.locator('#time')).toHaveText('00:00.0');
  await page.getByRole('button',{name:'Gaussian',exact:true}).click();
  await expect(page.getByRole('button',{name:'Gaussian',exact:true})).toHaveAttribute('aria-pressed','true');
  await page.screenshot({path:info.outputPath('rulab-gaussians.png'),fullPage:true});
  await page.getByRole('button',{name:'Graph',exact:true}).click();
  await seek(page,36);const original=await graphJson(page);await seek(page,84);await seek(page,36);expect(await graphJson(page)).toBe(original);
  // A slow renderer must not leave a snapshot behind the user's selected time.
  const immediate=await graphJson(page,43);expect(immediate).not.toBe(original);await seek(page,43);expect(await graphJson(page)).toBe(immediate);
  await page.screenshot({path:info.outputPath('rulab-graph.png'),fullPage:true});
  await page.getByRole('button',{name:'About this world'}).click();const metricDownload=page.waitForEvent('download');await page.getByRole('button',{name:'Export rendering evidence'}).click();const metricFile=await metricDownload;const measured=await readFile((await metricFile.path())!);const evidence=JSON.parse(measured.toString());expect(evidence.backend).toBe('webgl2');expect(evidence.frameSamples).toBeGreaterThan(2);expect(evidence.p95FrameMs).toBeGreaterThan(0);await info.attach('software-webgl-render-evidence',{body:measured,contentType:'application/json'});await page.getByRole('button',{name:'Close information'}).click();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('replays edits, preserves branches and round trips experiment files',async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await ready(page);await seek(page,12);await inspector(page);await page.getByRole('button',{name:'Pause this agent',exact:true}).click();
  await expect(page.getByRole('button',{name:'Resume this agent'})).toBeVisible();
  await seek(page,0);await expect(page.getByRole('button',{name:'Pause this agent',exact:true})).toBeVisible();
  await seek(page,20);await expect(page.getByRole('button',{name:'Resume this agent'})).toBeVisible();
  await page.getByRole('button',{name:'RF chamber door CLOSED'}).click();await page.getByRole('button',{name:'Open RF door',exact:true}).click();await expect(page.getByRole('button',{name:'Close RF door',exact:true})).toBeVisible();
  await seek(page,20);const originalGraph=await graphJson(page);
  const wait=page.waitForEvent('download');await page.getByRole('button',{name:'Export experiment',exact:true}).click();const file=await wait;const payload=await readFile((await file.path())!);const saved=JSON.parse(payload.toString());expect(saved.scenario).toBe('robotics');expect(saved.time).toBe(20);
  if(await page.getByRole('button',{name:'Toggle world inspector'}).getAttribute('aria-expanded')==='true')await page.getByRole('button',{name:'Toggle world inspector'}).click();await page.getByRole('button',{name:'02 Hospitality lab'}).click();await expect(page.locator('#scene-kicker')).toContainText('HOSPITALITY');
  await page.locator('#experiment-file').setInputFiles({name:'replay.json',mimeType:'application/json',buffer:payload});await expect(page.locator('#toast')).toContainText('Experiment restored');await expect(page.locator('#scene-kicker')).toContainText('ROBOTICS');await expect(page.locator('#time')).toHaveText('00:20.0');await expect(page.getByRole('button',{name:'01 Robotics lab'})).toHaveAttribute('aria-pressed','true');
  await seek(page,21);await seek(page,20);expect(await graphJson(page)).toBe(originalGraph);
  await page.locator('#experiment-file').setInputFiles({name:'invalid.json',mimeType:'application/json',buffer:Buffer.from('{"__proto__":{"polluted":true}}')});await expect(page.locator('#toast')).not.toContainText('Experiment restored');await expect(page.locator('#time')).toHaveText('00:20.0');expect(errors).toEqual([]);
});

test('imports bounded splats transactionally and restores the authored world',async({page})=>{
  await ready(page);const bytes=Buffer.alloc(32);bytes.writeFloatLE(.1,12);bytes.writeFloatLE(.1,16);bytes.writeFloatLE(.1,20);bytes.set([220,140,80,255,255,128,128,128],24);
  await page.locator('#splat-file').setInputFiles({name:'one.splat',mimeType:'application/octet-stream',buffer:bytes});await expect(page.locator('#toast')).toContainText('Local scene preview loaded');await expect(page.locator('#world')).toHaveAttribute('data-splats','1');
  await page.locator('#splat-file').setInputFiles({name:'blocked.rad',mimeType:'application/octet-stream',buffer:Buffer.alloc(32)});await expect(page.locator('#toast')).toContainText('RAD import is unavailable');await expect(page.locator('#world')).toHaveAttribute('data-splats','1');
  await page.getByRole('button',{name:'01 Robotics lab'}).click();await expect.poll(async()=>Number(await page.locator('#world').getAttribute('data-splats'))).toBeGreaterThan(42_000);
});

test('recovers visibly from a lost graphics context',async({page})=>{
  await ready(page);await page.evaluate(()=>{const canvas=document.querySelector<HTMLCanvasElement>('#world')!;const gl=canvas.getContext('webgl2');if(!gl)throw new Error('Expected real WebGL2');const extension=gl.getExtension('WEBGL_lose_context');if(!extension)throw new Error('Context-loss extension unavailable');extension.loseContext();});
  await expect(page.locator('#world')).toHaveAttribute('data-backend','unavailable');await expect(page.locator('#render-notice')).toBeVisible();await expect(page.locator('#reference')).not.toHaveClass(/rendered/);await seek(page,30);await expect(page.locator('#graph-count')).toHaveText('14');
});
