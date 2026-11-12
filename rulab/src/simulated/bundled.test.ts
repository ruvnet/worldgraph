import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fetchBounded, loadRolloutIndex, openBundledRollout, MAX_ROLLOUT_INDEX_BYTES } from './bundled';
import { verifiedRollout, verifyRollout } from './manifest';

/** A same-origin static host stub. Unknown paths answer like a missing file or an SPA fallback page. */
function host(files: Record<string, Uint8Array | string>, fallback: 'not-found' | 'html' = 'not-found') {
  const requested: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = String(input); requested.push(url);
    const body = files[url];
    if (body !== undefined) return new Response(body as BodyInit);
    return fallback === 'html' ? new Response('<!doctype html><title>RuLab</title>', { headers: { 'content-type': 'text/html' } }) : new Response('missing', { status: 404 });
  }) as typeof fetch;
  return { fetcher, requested };
}
const index = (rollouts: unknown) => JSON.stringify({ format: 'worldgraph.simulated.index', version: 1, rollouts });

describe('bundled rollout loading', () => {
  it('treats a missing index, a fallback page or a foreign document as no bundled rollouts', async () => {
    expect(await loadRolloutIndex('/worldgraph/', undefined, host({}).fetcher)).toEqual([]);
    expect(await loadRolloutIndex('/worldgraph/', undefined, host({}, 'html').fetcher)).toEqual([]);
    for (const body of ['', 'null', '[]', '{"format":"worldgraph.rulab.capture"}', 'x'.repeat(MAX_ROLLOUT_INDEX_BYTES + 1)])
      expect(await loadRolloutIndex('/worldgraph/', undefined, host({ '/worldgraph/simulated/index.json': body }).fetcher), body.slice(0, 20)).toEqual([]);
    expect(await loadRolloutIndex('/worldgraph/', undefined, (async () => { throw new TypeError('network down'); }) as typeof fetch)).toEqual([]);
    expect(await loadRolloutIndex('/worldgraph/', undefined, host({ '/worldgraph/simulated/index.json': index([]) }).fetcher)).toEqual([]);
  });

  it('lists entries and reports an index that claims the format but breaks it', async () => {
    const ok = host({ '/base/simulated/index.json': index([{ id: 'rf-door', path: 'rf-door/rollout.json' }]) });
    expect(await loadRolloutIndex('/base/', undefined, ok.fetcher)).toEqual([{ id: 'rf-door', path: 'rf-door/rollout.json' }]);
    expect(ok.requested).toEqual(['/base/simulated/index.json']);
    const bad = host({ '/base/simulated/index.json': index([{ id: 'rf-door', path: '../secret/rollout.json' }]) });
    await expect(loadRolloutIndex('/base/', undefined, bad.fetcher)).rejects.toThrow(/path must be exactly/);
  });

  it('opens and verifies the bundled synthetic rollout through flat sibling URLs only', async () => {
    const directory = resolve('public/simulated/synthetic-example'), prefix = '/worldgraph/simulated/synthetic-example/';
    const files: Record<string, Uint8Array> = {};
    for (const name of ['rollout.json', 'clip.mp4', 'caption.json']) files[prefix + name] = new Uint8Array(await readFile(resolve(directory, name)));
    const served = host(files), entry = { id: 'synthetic-example', path: 'synthetic-example/rollout.json' };
    const bundle = await openBundledRollout('/worldgraph/', entry, undefined, served.fetcher);
    expect(bundle.origin).toBe('bundled'); expect(served.requested).toEqual([prefix + 'rollout.json']);
    const checked = await verifyRollout(bundle);
    expect(new Uint8Array(await checked.media.arrayBuffer())).toEqual(files[prefix + 'clip.mp4']);
    expect(served.requested).toEqual(['rollout.json', 'clip.mp4', 'caption.json'].map(name => prefix + name));
    // A tampered or substituted video never becomes a verified rollout.
    const tampered = host({ ...files, [prefix + 'clip.mp4']: files[prefix + 'clip.mp4'].map((byte, i) => i === 100 ? byte ^ 1 : byte) });
    const second = await openBundledRollout('/worldgraph/', entry, undefined, tampered.fetcher);
    await expect(verifyRollout(second)).rejects.toThrow(/SHA-256 mismatch for clip\.mp4/); expect(verifiedRollout(second)).toBeNull();
    const fallback = host({ [prefix + 'rollout.json']: files[prefix + 'rollout.json'] }, 'html');
    await expect(verifyRollout(await openBundledRollout('/worldgraph/', entry, undefined, fallback.fetcher))).rejects.toThrow(/Byte length mismatch for clip\.mp4/);
    await expect(openBundledRollout('/worldgraph/', entry, undefined, host({}).fetcher)).rejects.toThrow(/could not load: synthetic-example\/rollout\.json/);
    await expect(openBundledRollout('/worldgraph/', entry, undefined, host({}, 'html').fetcher)).rejects.toThrow(/rollout\.json is not valid JSON/);
  });

  it('stops reading at the byte bound', async () => {
    const big = host({ '/x': new Uint8Array(4096) });
    await expect(fetchBounded('/x', 1024, undefined, big.fetcher)).rejects.toThrow(/exceeds its 1024 byte limit/);
    expect((await fetchBounded('/x', 4096, undefined, big.fetcher))!.byteLength).toBe(4096);
    expect(await fetchBounded('/missing', 10, undefined, big.fetcher)).toBeNull();
  });
});
