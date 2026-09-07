import {test,expect,type Page} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
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

async function captureSeek(page:Page,time:number,index:number){
  await page.getByRole('slider',{name:'Capture time'}).evaluate((element,value)=>{(element as HTMLInputElement).value=String(value);element.dispatchEvent(new Event('input',{bubbles:true}));},time);
  await expect(page.locator('#capture-frame')).toHaveAttribute('data-index',String(index));
  await expect(page.locator('#capture-frame')).toHaveAttribute('data-loading','false');
  await expect(page.locator('#graph-count')).toHaveAttribute('data-time',String(time));
}
test('plays a Gaussian capture with verified provenance and holds the last valid frame',async({page},info)=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await ready(page);
  await page.getByRole('button',{name:'Open 4D capture',exact:true}).click();
  await page.getByRole('button',{name:'Try synthetic 4D example'}).click();
  await expect(page.locator('.workspace')).toHaveAttribute('data-world-kind','capture');
  await expect(page.locator('#world')).toHaveAttribute('data-splats','2847');
  await expect(page.locator('#graph-count')).toHaveText('2');
  await expect(page.locator('#graph-count')).toHaveAttribute('data-world','capture');
  await expect(page.getByRole('slider',{name:'Capture time'})).toHaveAttribute('max','4');
  await inspector(page);await expect(page.locator('#capture-source')).toHaveText('synthetic');
  await page.getByRole('button',{name:'Play capture'}).click();await expect(page.locator('#time')).not.toHaveText('00:00.0');await page.getByRole('button',{name:'Pause capture'}).click();await captureSeek(page,0,0);
  const initial=await graphJson(page);const graph=JSON.parse(initial);
  expect(graph.nodes).toHaveLength(2);expect(graph.edges).toHaveLength(1);
  const provenance=JSON.parse(graph.nodes.find((n:{id:number})=>n.id===41001).statement);
  expect(provenance.registration).toBe('unverified');expect(provenance.declaredSource).toBe('synthetic');
  const originalManifest=await readFile('public/capture-example/capture.json');
  expect(provenance.manifestSha256).toBe(createHash('sha256').update(originalManifest).digest('hex'));
  const captureDownload=page.waitForEvent('download');await page.getByRole('button',{name:'Export capture manifest'}).click();
  expect(await readFile((await (await captureDownload).path())!)).toEqual(originalManifest);
  const camera=await page.locator('#world').getAttribute('data-camera');
  await captureSeek(page,2,2);await expect(page.locator('#world')).toHaveAttribute('data-camera',camera!);
  await page.screenshot({path:info.outputPath('rulab-capture.png'),fullPage:true});
  await captureSeek(page,0,0);expect(await graphJson(page)).toBe(initial);
  // Invalid first sample must not replace the accepted bundle or its Rust provenance.
  const bytes=Buffer.alloc(32);bytes.writeFloatLE(.1,12);bytes.writeFloatLE(.1,16);bytes.writeFloatLE(.1,20);bytes.set([220,140,80,255,255,128,128,128],24);
  const hash=createHash('sha256').update(bytes).digest('hex');
  const manifest={format:'worldgraph.rulab.capture',version:1,name:'Failure boundary',source:'observed',coordinateSystem:'right-handed-y-up',units:'metres',duration:2,bounds:{min:[-1,-1,-1],max:[1,1,1]},frames:[{time:0,file:'a.splat',sha256:'0'.repeat(64)},{time:1,file:'b.splat',sha256:'0'.repeat(64)}]};
  const files=()=>[{name:'capture.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(manifest))},...['a.splat','b.splat'].map(name=>({name,mimeType:'application/octet-stream',buffer:bytes}))];
  await page.locator('#capture-files').setInputFiles(files());await expect(page.locator('#toast')).toContainText('SHA-256');
  await expect(page.locator('#world')).toHaveAttribute('data-splats','2847');expect(await graphJson(page)).toBe(initial);
  // A later bad hash leaves the accepted sample visible and requires an explicit retry.
  manifest.frames[0].sha256=hash;await page.locator('#capture-files').setInputFiles(files());
  await expect(page.locator('#capture-title')).toHaveText('Failure boundary');await expect(page.locator('#world')).toHaveAttribute('data-splats','1');
  await captureSeek(page,1,0);await inspector(page);await expect(page.locator('#capture-state')).toContainText('SHA-256');
  await expect(page.getByRole('button',{name:'Retry capture frame'})).toBeVisible();
  await expect(page.locator('#capture-requested')).toHaveText('00:01.0');await expect(page.locator('#capture-displayed')).toHaveText('00:00.0');
  const failed=JSON.parse(await graphJson(page));const displayed=JSON.parse(failed.nodes.find((n:{id:number})=>n.id===41002).statement);
  expect(displayed.displayedFileSha256).toBe(hash);expect(displayed.requestedTime).toBe(1);expect(displayed.displayedTime).toBe(0);expect(displayed.error).toContain('SHA-256');
  await page.getByRole('button',{name:'Retry capture frame'}).click();await expect(page.locator('#capture-state')).toContainText('SHA-256');await expect(page.locator('#world')).toHaveAttribute('data-splats','1');
  await captureSeek(page,0,0);await expect(page.getByRole('button',{name:'Play capture'})).toBeEnabled();
  if(await page.getByRole('button',{name:'Toggle world inspector'}).getAttribute('aria-expanded')==='true')await page.getByRole('button',{name:'Toggle world inspector'}).click();
  await page.getByRole('button',{name:'01 Robotics lab'}).click();await expect(page.locator('#graph-count')).toHaveText('14');await expect(page.getByRole('slider',{name:'Experiment time'})).toHaveAttribute('max','120');
  await expect.poll(async()=>Number(await page.locator('#world').getAttribute('data-splats'))).toBeGreaterThan(42_000);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(errors).toEqual([]);
});

test('ignores an experiment read completed after a newer environment choice',async({page})=>{
  await ready(page);
  const wait=page.waitForEvent('download');await page.getByRole('button',{name:'Export experiment',exact:true}).click();
  const payload=await readFile((await (await wait).path())!);
  // Controlled fixture delays only this selected file; no production test hook.
  await page.evaluate(()=>{const original=File.prototype.text;File.prototype.text=function(){const pending=original.call(this);if(this.name!=='delayed.json')return pending;return pending.then(value=>new Promise<string>(resolve=>{document.addEventListener('release-test-file',()=>resolve(value),{once:true});document.documentElement.dataset.testFileReadReady='true';}));};});
  await page.locator('#experiment-file').setInputFiles({name:'delayed.json',mimeType:'application/json',buffer:payload});
  await expect(page.locator('html')).toHaveAttribute('data-test-file-read-ready','true');
  await page.getByRole('button',{name:'02 Hospitality lab'}).click();
  await page.evaluate(()=>document.dispatchEvent(new Event('release-test-file')));
  await expect(page.locator('#scene-kicker')).toContainText('HOSPITALITY');
  await expect(page.getByRole('button',{name:'02 Hospitality lab'})).toHaveAttribute('aria-pressed','true');
  // A new import proves the prior continuation finished and released its busy slot.
  await page.locator('#experiment-file').setInputFiles({name:'immediate.json',mimeType:'application/json',buffer:payload});
  await expect(page.locator('#toast')).toContainText('Experiment restored');await expect(page.locator('#scene-kicker')).toContainText('ROBOTICS');
});

test('loads photographic assets and switches GPU quality without changing replay',async({page},info)=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await ready(page);
  await expect(page.locator('#world')).toHaveAttribute('data-graphics',/"photographicMaps":6/, {timeout:60_000});
  await expect(page.locator('#world')).toHaveAttribute('data-graphics',/photographic HDR/);
  await seek(page,24);const graph=await graphJson(page);
  await page.getByRole('button',{name:'Graphics settings',exact:true}).click();
  await page.getByLabel('Rendering quality',{exact:true}).selectOption('quality');
  await expect(page.locator('#world')).toHaveAttribute('data-graphics',/"reflections":true/);
  await page.getByRole('slider',{name:'Exposure',exact:true}).evaluate(element=>{(element as HTMLInputElement).value='0.8';element.dispatchEvent(new Event('input',{bubbles:true}));});
  await expect(page.locator('#world')).toHaveAttribute('data-graphics',/"exposure":0.8/);
  await page.getByRole('button',{name:'Close graphics settings'}).click();
  await page.screenshot({path:info.outputPath('rulab-gpu-quality.png'),fullPage:true});
  expect(await graphJson(page)).toBe(graph);
  await page.getByRole('button',{name:'Graphics settings',exact:true}).click();
  await page.getByLabel('Rendering quality',{exact:true}).selectOption('performance');
  await expect(page.locator('#world')).toHaveAttribute('data-graphics',/"reflections":false/);
  await expect(page.locator('#world')).toHaveAttribute('data-graphics',/"quality":"performance"/);
  await page.getByRole('button',{name:'Close graphics settings'}).click();
  expect(await graphJson(page)).toBe(graph);expect(errors).toEqual([]);
});

test('missing photographic assets retain a navigable fallback',async({page})=>{
  await page.route('**/graphics/*',route=>route.fulfill({status:404,body:'missing test fixture'}));
  await ready(page);await page.getByRole('button',{name:'Graphics settings',exact:true}).click();
  await expect(page.locator('#graphics-status')).toContainText('0/6 photographic maps');
  await expect(page.locator('#graphics-status')).toContainText('generated room');
  await page.getByRole('button',{name:'Close graphics settings'}).click();
  await page.getByRole('button',{name:'Robot',exact:true}).click();
  await seek(page,18);await expect(page.locator('#graph-count')).toHaveText('14');
  await expect(page.locator('#world')).toHaveAttribute('data-backend','webgl2');
});
