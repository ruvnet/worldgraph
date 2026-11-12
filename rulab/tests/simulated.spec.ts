import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const BANNER = 'SIMULATED · MODEL PREDICTION · NOT A CAPTURE';
const fixture = (name: string) => readFile(new URL(`../public/simulated/synthetic-example/${name}`, import.meta.url));

async function ready(page: Page) {
  await page.goto('./');
  await expect(page.locator('#world')).toHaveAttribute('data-backend', 'webgl2');
  await expect(page.locator('#graph-status')).toHaveText('Rust graph · WebAssembly');
  await expect(page.locator('#graph-count')).toHaveText('14');
}
/** The authored world is exactly as it was: same Rust graph, no capture mode, same timeline. */
async function expectAuthoredWorld(page: Page) {
  await expect(page.locator('#graph-count')).toHaveText('14');
  await expect(page.locator('#graph-count')).toHaveAttribute('data-world', 'authored');
  await expect(page.locator('.source-pill')).toHaveText('Authored world');
  await expect(page.locator('.workspace')).not.toHaveClass(/capture-preview/);
  await expect(page.locator('#capture-details')).toBeHidden();
  await expect(page.getByRole('slider', { name: 'Experiment time' })).toHaveAttribute('max', '120');
}
async function authoredGraphJson(page: Page) {
  await page.getByRole('button', { name: 'About this world' }).click();
  const wait = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export WorldGraph snapshot' }).click();
  const data = await readFile((await (await wait).path())!, 'utf8');
  await page.getByRole('button', { name: 'Close information' }).click();
  return data;
}
const openPicker = (page: Page) => page.getByRole('button', { name: 'Open simulated rollout' }).click();

test('plays the bundled synthetic rollout as a labelled model prediction beside the authored world', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await ready(page);
  const manifest = JSON.parse((await fixture('rollout.json')).toString());
  const authoredBefore = await authoredGraphJson(page);
  await openPicker(page);
  await page.getByRole('button', { name: 'Open bundled rollout synthetic-example' }).click();

  const panel = page.locator('#rollout-panel');
  await expect(panel).toBeVisible();
  await expect(page.locator('#rollout-banner')).toBeVisible();
  await expect(page.locator('#rollout-banner')).toHaveText(BANNER);
  await expect(page.locator('#rollout-name')).toHaveText('Synthetic test pattern (not model output)');
  await expect(page.locator('#rollout-provider')).toHaveText('mock');
  await expect(page.locator('#rollout-model')).toHaveText('deterministic-fixture');
  await expect(page.locator('#rollout-checkpoint')).toHaveText('builtin-v1');
  await expect(page.locator('#rollout-license')).toHaveText('MIT OR Apache-2.0');
  await expect(page.locator('#rollout-seed')).toHaveText('0');

  // The digest on screen is the manifest's, and is the SHA-256 of the bytes the server actually ships.
  const shown = await page.locator('#rollout-sha256').textContent();
  expect(shown).toBe(manifest.media.sha256);
  const served = await page.request.get('simulated/synthetic-example/clip.mp4');
  expect(createHash('sha256').update(await served.body()).digest('hex')).toBe(shown);

  // A real <video> element decodes the verified bytes from a Blob URL, outside the Gaussian canvas.
  const video = page.locator('#rollout-video');
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.duration)).toBeGreaterThan(0);
  const media = await video.evaluate((element: HTMLVideoElement) => ({ duration: element.duration, width: element.videoWidth, height: element.videoHeight, src: element.currentSrc, inCanvas: Boolean(element.closest('.world-surface')) }));
  expect(media.duration).toBeCloseTo(manifest.media.durationSec, 1);
  expect([media.width, media.height]).toEqual([manifest.media.width, manifest.media.height]);
  expect(media.src.startsWith('blob:')).toBe(true); expect(media.inCanvas).toBe(false);
  await expect(page.locator('#rollout-decoded')).toHaveCount(0);
  await video.evaluate(async (element: HTMLVideoElement) => { element.muted = true; await element.play(); });
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(0);
  await expect(page.locator('#rollout-banner')).toBeVisible();

  await page.locator('#rollout-caption summary').click();
  await expect(page.locator('#rollout-caption-text')).toContainText('No world model was prompted');
  await expect(page.locator('#rollout-first-frame')).toBeHidden();
  await page.screenshot({ path: info.outputPath('rulab-simulated-rollout.png'), fullPage: true });

  // The rollout has its own Rust graph; the authored one underneath is untouched and still running.
  await expect(page.locator('#rollout-graph-status')).toHaveAttribute('data-nodes', '2');
  const wait = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export rollout graph' }).click();
  const graph = JSON.parse((await readFile((await (await wait).path())!)).toString());
  expect(graph.nodes.map((node: { id: number }) => node.id).sort()).toEqual([42001, 42002]);
  expect(graph.nodes.every((node: { kind: string; confidence: number }) => node.kind === 'semantic_state' && node.confidence === 0)).toBe(true);
  expect(JSON.parse(graph.nodes.find((node: { id: number }) => node.id === 42001).statement)).toMatchObject({ simulated: true, provider: 'mock', model: 'deterministic-fixture', mediaSha256: manifest.media.sha256 });
  expect(graph.edges).toHaveLength(1);
  await expectAuthoredWorld(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  await page.getByRole('button', { name: 'Close simulated rollout' }).click();
  await expect(panel).toBeHidden();
  expect(await video.evaluate((element: HTMLVideoElement) => element.getAttribute('src'))).toBeNull();
  await expectAuthoredWorld(page);
  await expect.poll(async () => Number(await page.locator('#world').getAttribute('data-splats'))).toBeGreaterThan(42_000);
  // Byte-identical authored graph: opening, playing and closing a rollout wrote nothing into it.
  const authoredAfter = await authoredGraphJson(page);
  expect(authoredAfter).toBe(authoredBefore);
  expect(authoredAfter).not.toContain('42001'); expect(authoredAfter).not.toContain('simulated');
  expect(errors).toEqual([]);
});

test('refuses to play a rollout whose video bytes do not match the manifest SHA-256', async ({ page }) => {
  await ready(page);
  const tampered = Buffer.from(await fixture('clip.mp4')); tampered[tampered.length - 1] ^= 1;
  await page.route('**/simulated/synthetic-example/clip.mp4', route => route.fulfill({ status: 200, contentType: 'video/mp4', body: tampered }));
  await openPicker(page);
  await page.getByRole('button', { name: 'Open bundled rollout synthetic-example' }).click();
  await expect(page.locator('#rollout-picker-error')).toBeVisible();
  await expect(page.locator('#rollout-picker-error')).toContainText('SHA-256 mismatch for clip.mp4');
  await expect(page.locator('#rollout-panel')).toBeHidden();
  expect(await page.locator('#rollout-video').evaluate((element: HTMLVideoElement) => element.getAttribute('src'))).toBeNull();
  await page.getByRole('button', { name: 'Close rollout picker' }).click();
  await expectAuthoredWorld(page);
});

test('works without a bundled index and opens a local multi-file rollout selection', async ({ page }) => {
  await ready(page);
  await page.route('**/simulated/index.json', route => route.fulfill({ status: 404, body: 'not found' }));
  await openPicker(page);
  await expect(page.locator('#rollout-empty')).toHaveText('No bundled rollouts');
  const files = await Promise.all(['rollout.json', 'clip.mp4', 'caption.json'].map(async name => ({ name, mimeType: 'application/octet-stream', buffer: await fixture(name) })));
  // A capture manifest renamed to rollout.json is rejected: a rollout never goes through the capture format.
  const capture = await readFile(new URL('../public/capture-example/capture.json', import.meta.url));
  await page.locator('#rollout-files').setInputFiles([{ name: 'rollout.json', mimeType: 'application/json', buffer: capture }, files[1], files[2]]);
  await expect(page.locator('#rollout-picker-error')).toContainText('unsupported field');
  await expect(page.locator('#rollout-panel')).toBeHidden();
  await page.locator('#rollout-files').setInputFiles(files);
  await expect(page.locator('#rollout-panel')).toBeVisible();
  await expect(page.locator('#rollout-banner')).toHaveText(BANNER);
  await expect.poll(() => page.locator('#rollout-video').evaluate((element: HTMLVideoElement) => element.duration)).toBeGreaterThan(0);
  await expect(page.locator('#rollout-first-frame')).toBeHidden();
  await expectAuthoredWorld(page);
  await page.locator('#rollout-panel').press('Escape');
  await expect(page.locator('#rollout-panel')).toBeHidden();

  // The same rollout with a conditioning image and measured generation statistics, as a real model run would ship.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  const manifest = JSON.parse(files[0].buffer.toString());
  manifest.name = 'Local rollout <img src=x onerror=alert(1)>';
  manifest.firstFrame = { file: 'first.png', sha256: digest(png), bytes: png.length };
  manifest.generation = { hardware: '1x H200 NVL 140GB', steps: 50, seconds: 412.5, peakVramGb: 96.2 };
  const withFrame = (image: Buffer) => [{ name: 'rollout.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(manifest)) }, files[1], files[2], { name: 'first.png', mimeType: 'image/png', buffer: image }];
  await openPicker(page);
  const wrong = Buffer.from(png); wrong[wrong.length - 1] ^= 1;
  await page.locator('#rollout-files').setInputFiles(withFrame(wrong));
  await expect(page.locator('#rollout-picker-error')).toContainText('SHA-256 mismatch for first.png');
  await expect(page.locator('#rollout-panel')).toBeHidden();
  await page.locator('#rollout-files').setInputFiles(withFrame(png));
  await expect(page.locator('#rollout-panel')).toBeVisible();
  // Manifest text is rendered as text, never as markup.
  await expect(page.locator('#rollout-name')).toHaveText('Local rollout <img src=x onerror=alert(1)>');
  await expect(page.locator('#rollout-name img')).toHaveCount(0);
  await expect(page.locator('#rollout-first-frame')).toBeVisible();
  await expect.poll(() => page.locator('#rollout-first-frame-image').evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(1);
  expect(await page.locator('#rollout-first-frame-image').evaluate((element: HTMLImageElement) => element.src.startsWith('blob:'))).toBe(true);
  await expect(page.locator('#rollout-facts')).toContainText('1x H200 NVL 140GB');
  await expect(page.locator('#rollout-facts')).toContainText('412.5 s');
  await expect(page.locator('#rollout-facts')).toContainText('96.2 GB');
  await expect(page.locator('#rollout-facts')).toContainText('50');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Close simulated rollout' }).click();
  await expectAuthoredWorld(page);
});

test('leaves an open time-indexed capture untouched while a rollout is shown over it', async ({ page }) => {
  await ready(page);
  await page.getByRole('button', { name: 'Open 4D capture', exact: true }).click();
  await page.getByRole('button', { name: 'Try synthetic 4D example' }).click();
  await expect(page.locator('.workspace')).toHaveAttribute('data-world-kind', 'capture');
  await expect(page.locator('#world')).toHaveAttribute('data-splats', '2847');
  await expect(page.locator('#graph-count')).toHaveText('2');
  const captureState = () => page.evaluate(() => {
    const text = (id: string) => document.getElementById(id)!.textContent;
    const frame = document.getElementById('capture-frame')!, count = document.getElementById('graph-count')!, workspace = document.querySelector<HTMLElement>('.workspace')!;
    return { kind: workspace.dataset.worldKind, classes: workspace.className, pill: document.querySelector('.source-pill')!.textContent, title: text('capture-title'), digest: document.getElementById('capture-digest')!.title,
      frame: frame.dataset.index, displayedTime: frame.dataset.displayedTime, requested: text('capture-requested'), displayed: text('capture-displayed'), source: text('capture-source'), state: text('capture-state'),
      graphNodes: count.textContent, graphWorld: count.dataset.world, graphStatus: text('graph-status'), time: text('time'), sliderMax: document.querySelector<HTMLInputElement>('#timeline')!.max,
      sliderLabel: document.querySelector('#timeline')!.getAttribute('aria-label'), splats: document.getElementById('world')!.dataset.splats };
  });
  await expect(page.locator('#capture-frame')).toHaveAttribute('data-loading', 'false');
  const before = await captureState();
  expect(before).toMatchObject({ kind: 'capture', pill: 'Time-indexed capture', frame: '0', graphNodes: '2', graphWorld: 'capture', sliderLabel: 'Capture time', splats: '2847' });

  await openPicker(page);
  await page.getByRole('button', { name: 'Open bundled rollout synthetic-example' }).click();
  await expect(page.locator('#rollout-panel')).toBeVisible();
  await expect(page.locator('#rollout-banner')).toHaveText(BANNER);
  const video = page.locator('#rollout-video');
  await video.evaluate(async (element: HTMLVideoElement) => { element.muted = true; await element.play(); });
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(0);
  // The rollout graph is its own two nodes; the capture graph count, sample and timeline did not move.
  await expect(page.locator('#rollout-graph-status')).toHaveAttribute('data-nodes', '2');
  expect(await captureState()).toEqual(before);
  await page.getByRole('button', { name: 'Close simulated rollout' }).click();
  await expect(page.locator('#rollout-panel')).toBeHidden();
  expect(await captureState()).toEqual(before);
  // The capture's own export still holds only capture nodes.
  const wait = page.waitForEvent('download');
  await page.locator('#capture-snapshot').evaluate((button: HTMLButtonElement) => button.click());
  const captureGraph = JSON.parse(await readFile((await (await wait).path())!, 'utf8'));
  expect(captureGraph.nodes.map((node: { id: number }) => node.id).sort()).toEqual([41001, 41002]);
});
