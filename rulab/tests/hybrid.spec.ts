import {test,expect,type Page} from '@playwright/test';
import {writeFile} from 'node:fs/promises';

async function diagnostics(page:Page){
  return page.evaluate(()=>{if(!window.__coast)throw new Error('Coastal renderer diagnostics are unavailable.');return window.__coast.diagnostics();});
}

async function seek(page:Page,time:number){
  await page.getByRole('slider',{name:'Synthetic replay time'}).evaluate((element,value)=>{
    (element as HTMLInputElement).value=String(value);
    element.dispatchEvent(new Event('input',{bubbles:true}));
  },time);
  await expect(page.getByRole('button',{name:'Play synthetic replay',exact:true})).toBeVisible();
  await expect.poll(async()=>{
    const graph=await page.evaluate(()=>JSON.parse(window.__coast!.graphJson()));
    const states=graph.nodes.filter((node:{kind:string})=>node.kind==='semantic_state');
    return states.length===3&&states.every((node:{statement:string})=>JSON.parse(node.statement).replaySeconds===time);
  }).toBe(true);
  expect((await diagnostics(page)).time).toBe(time);
}

async function graphState(page:Page){
  return page.evaluate(()=>{
    const graph=JSON.parse(window.__coast!.graphJson());
    const order=(a:{id:number},b:{id:number})=>a.id-b.id;
    // Retain complete node and edge state; normalize only collection order.
    return {nodes:graph.nodes.sort(order),edges:graph.edges.sort(order)};
  });
}

test('hybrid coast renders, replays and withholds unsupported evidence',async({page},info)=>{
  const errors:string[]=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto('./hybrid.html');
  const canvas=page.locator('#coast');
  await expect(canvas).toHaveAttribute('data-backend','webgl2');
  await expect(canvas).toHaveAttribute('data-source','synthetic');
  await expect(canvas).toHaveAttribute('data-graph-status','ready');
  await expect(page.locator('#coast-loading')).toBeHidden();
  await expect(page.locator('.coast-provenance')).toHaveText('SYNTHETIC SCENE · NO SENSORS CONNECTED');
  await expect.poll(async()=>(await diagnostics(page)).frameSamples).toBeGreaterThan(3);
  const initial=await diagnostics(page);
  expect(initial.graphNodes).toBe(7);
  expect(initial.actors.map(actor=>actor.id)).toEqual(['coast-walker-1','coast-walker-2','coast-vehicle-1']);
  expect(initial.splatCount).toBeGreaterThan(0);expect(initial.splatCount).toBeLessThanOrEqual(65_000);
  expect(initial.drawCalls).toBeGreaterThan(0);expect(initial.sensorConnected).toBe(false);
  expect(initial.collisionProxyCount).toBeGreaterThan(0);

  await test.step('independent appearance, geometry and evidence visibility',async()=>{
    await page.locator('#layer-splats').click();
    await expect(canvas).toHaveAttribute('data-splats-visible','false');
    await expect(canvas).toHaveAttribute('data-meshes-visible','true');
    expect((await diagnostics(page)).renderedLayers).toEqual({splats:false,staticMeshes:true,dynamicMeshes:true,evidence:false});
    await page.locator('#layer-meshes').click();
    await expect(canvas).toHaveAttribute('data-meshes-visible','false');
    expect((await diagnostics(page)).renderedLayers).toEqual({splats:false,staticMeshes:false,dynamicMeshes:false,evidence:false});
    await page.locator('#layer-splats').click();
    expect((await diagnostics(page)).renderedLayers).toEqual({splats:true,staticMeshes:false,dynamicMeshes:false,evidence:false});
    await page.locator('#layer-meshes').click();
  });

  await test.step('deterministic Rust graph and independent camera',async()=>{
    await seek(page,23.5);
    const original=await diagnostics(page),graph=await graphState(page);
    await seek(page,71.2);expect((await diagnostics(page)).actors).not.toEqual(original.actors);
    await seek(page,23.5);expect((await diagnostics(page)).actors).toEqual(original.actors);
    expect(await graphState(page)).toEqual(graph);
    await page.getByRole('button',{name:'Promenade',exact:true}).click();
    await expect.poll(async()=>(await diagnostics(page)).camera).not.toEqual(original.camera);
    expect((await diagnostics(page)).time).toBe(23.5);
    expect((await diagnostics(page)).actors).toEqual(original.actors);
    expect(await graphState(page)).toEqual(graph);
  });

  await test.step('count, stale, registration and privacy cases cannot locate actors',async()=>{
    await page.locator('#layer-evidence').click();
    await expect(canvas).toHaveAttribute('data-evidence-visible','true');
    const evidenceCase=page.getByRole('combobox',{name:'Synthetic evidence case'});
    await evidenceCase.selectOption('count');
    await expect(canvas).toHaveAttribute('data-counts','3');
    await expect(canvas).toHaveAttribute('data-markers','0');
    const count=await diagnostics(page);expect(count.evidence.markers).toHaveLength(0);expect(count.evidence.counts[0].count).toBe(3);
    for(const name of ['blackout','registration','privacy']){
      await evidenceCase.selectOption(name);
      await expect(canvas).toHaveAttribute('data-evidence-rejected','true');
      await expect(canvas).toHaveAttribute('data-markers','0');
      await expect(canvas).toHaveAttribute('data-counts','0');
      expect((await diagnostics(page)).evidence.markers).toHaveLength(0);
    }
    await evidenceCase.selectOption('located');
    await expect(canvas).toHaveAttribute('data-markers','3');
    expect((await diagnostics(page)).renderedLayers.evidence).toBe(true);
    await page.getByRole('button',{name:'Hold feed to test expiry'}).click();
    await expect(page.locator('#hold-evidence')).toHaveAttribute('aria-pressed','true');
    await expect(canvas).toHaveAttribute('data-markers','0');
    const expired=await diagnostics(page);expect(expired.feedHeld).toBe(true);expect(expired.evidence.rejected).toBe(true);
    await page.getByRole('button',{name:'Resume synthetic feed'}).click();
    await expect(canvas).toHaveAttribute('data-markers','3');
    await page.locator('#layer-evidence').click();
    expect((await diagnostics(page)).renderedLayers.evidence).toBe(false);
  });

  await page.getByRole('button',{name:'Coast',exact:true}).click();
  await expect(page.getByRole('button',{name:'Coast',exact:true})).toHaveAttribute('aria-pressed','true');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await expect.poll(async()=>(await diagnostics(page)).frameSamples).toBeGreaterThan(3);
  const screenshot=info.outputPath(`hybrid-${info.project.name}.png`);
  await page.screenshot({path:screenshot,fullPage:false});
  await info.attach(`hybrid-${info.project.name}`,{path:screenshot,contentType:'image/png'});
  const measured=await diagnostics(page);
  expect(measured.frameSamples).toBeGreaterThan(3);expect(measured.p95FrameMs).toBeGreaterThan(0);
  const receipt=info.outputPath(`hybrid-${info.project.name}.json`);
  await writeFile(receipt,JSON.stringify({project:info.project.name,viewport:page.viewportSize(),diagnostics:measured,graph:await graphState(page),pageErrors:errors},null,2));
  await info.attach('coastal-rendering-evidence',{path:receipt,contentType:'application/json'});
  expect(errors).toEqual([]);
});
