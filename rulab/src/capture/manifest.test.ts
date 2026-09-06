import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { loadCaptureFiles, loadCaptureFrame, selectCaptureFrame, verifiedCaptureFrameSha256, captureManifestFile, MAX_CAPTURE_MANIFEST_BYTES } from './manifest';
import type { CaptureManifest } from './types';

function fixture(count = 3) {
  const data = new Uint8Array(32); new DataView(data.buffer).setFloat32(12, 0.1, true); data.set([200, 150, 90, 255, 255, 128, 128, 128], 24);
  const hash = createHash('sha256').update(data).digest('hex');
  const manifest: any = { format: 'worldgraph.rulab.capture', version: 1, name: 'Local appearance', source: 'synthetic', coordinateSystem: 'right-handed-y-up', units: 'metres', duration: 120,
    bounds: { min: [-2, 0, -2], max: [2, 3, 2] }, frames: Array.from({ length: count }, (_, i) => ({ time: count === 1 ? 0 : i * 120 / (count - 1), file: `frame-${i}.splat`, sha256: hash })) };
  const frames = manifest.frames.map((f: { file: string }) => new File([data], f.file)) as File[];
  const files = () => [new File([JSON.stringify(manifest)], 'capture.json'), ...frames];
  return { data, hash, manifest, frames, files };
}

describe('bounded local capture manifests', () => {
  it('freezes metadata and exposes a file table without mutation methods', async () => {
    const f = fixture(), selected = f.files(), bundle = await loadCaptureFiles(selected);
    expect(bundle.manifestSha256).toBe(createHash('sha256').update(await selected[0].text()).digest('hex'));
    expect(bundle.files.size).toBe(3); expect([...bundle.files.keys()]).toEqual(f.manifest.frames.map((x: any) => x.file));
    expect(Object.isFrozen(bundle)).toBe(true); expect(Object.isFrozen(bundle.manifest)).toBe(true);
    expect(() => (bundle.manifest.frames as any).push({})).toThrow();
    expect(() => (bundle.manifest.bounds.min as any)[0] = 99).toThrow();
    expect(() => (bundle.manifest.frames[0] as any).sha256 = '0'.repeat(64)).toThrow();
    expect((bundle.files as any).set).toBeUndefined(); expect((bundle.files as any).delete).toBeUndefined();
    bundle.files.forEach((_value, _key, map) => expect(map).toBe(bundle.files));
    selected.pop(); f.manifest.name = 'Changed externally';
    expect(bundle.manifest.name).toBe('Local appearance'); expect(bundle.files.size).toBe(3);
  });

  it('exports exact manifest bytes and hash across BOM, whitespace and a second import', async () => {
    const f = fixture(), raw = '\uFEFF \n\t' + JSON.stringify(f.manifest, null, 2) + '\n  ';
    const source = new File([raw], 'capture.json'), sourceBytes = new Uint8Array(await source.arrayBuffer());
    const bundle = await loadCaptureFiles([source, ...f.frames]), exported = captureManifestFile(bundle);
    const bytes = new Uint8Array(await exported.arrayBuffer());
    expect(exported.name).toBe('capture.json'); expect(exported.type).toBe('application/json');
    expect(bytes).toEqual(sourceBytes); expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(bundle.manifestSha256);
    const restored = await loadCaptureFiles([exported, ...f.frames]);
    expect(restored.manifestSha256).toBe(bundle.manifestSha256); expect(restored.manifest).toEqual(bundle.manifest);
    Object.defineProperty(exported, 'arrayBuffer', { value: async () => new ArrayBuffer(0) });
    const anotherExport = captureManifestFile(bundle);
    expect(anotherExport).not.toBe(exported); expect(new Uint8Array(await anotherExport.arrayBuffer())).toEqual(sourceBytes);
    expect(() => captureManifestFile({ ...bundle })).toThrow(/validate capture/);
  });

  it('verifies SHA-256 before existing SPLAT preflight and records only successful verification', async () => {
    const f = fixture(), bundle = await loadCaptureFiles(f.files());
    expect(verifiedCaptureFrameSha256(bundle, 0)).toBeNull();
    const result = await loadCaptureFrame(bundle, 0);
    expect(result.bytes).toEqual(f.data); expect(result.fileType).toBeDefined();
    expect(verifiedCaptureFrameSha256(bundle, 0)).toBe(f.hash);
    const corrupt = fixture(1); corrupt.manifest.frames[0].sha256 = '0'.repeat(64);
    const bad = await loadCaptureFiles(corrupt.files());
    await expect(loadCaptureFrame(bad, 0)).rejects.toThrow(/SHA-256 mismatch/);
    expect(verifiedCaptureFrameSha256(bad, 0)).toBeNull();
    const invalid = fixture(1); new DataView(invalid.data.buffer).setFloat32(0, NaN, true);
    invalid.manifest.frames[0].sha256 = createHash('sha256').update(invalid.data).digest('hex');
    invalid.frames[0] = new File([invalid.data], 'frame-0.splat');
    const malformed = await loadCaptureFiles(invalid.files());
    await expect(loadCaptureFrame(malformed, 0)).rejects.toThrow(/invalid coordinates/);
    expect(verifiedCaptureFrameSha256(malformed, 0)).toBeNull();
  });

  it('preflights the same hashed byte snapshot, reads each source once and never fetches a URL', async () => {
    const f = fixture(1), bundle = await loadCaptureFiles(f.files());
    const originalRead = f.frames[0].arrayBuffer.bind(f.frames[0]);
    const reads = vi.spyOn(f.frames[0], 'arrayBuffer').mockImplementationOnce(originalRead).mockResolvedValue(new ArrayBuffer(0));
    const fetch = vi.spyOn(globalThis, 'fetch');
    try { const decoded = await loadCaptureFrame(bundle, 0); expect(decoded.bytes).toEqual(f.data); expect(reads).toHaveBeenCalledTimes(1); expect(fetch).not.toHaveBeenCalled(); }
    finally { reads.mockRestore(); fetch.mockRestore(); }
  });

  it.each([
    ['wrong format', (m: any) => m.format = 'anything'], ['wrong version', (m: any) => m.version = 2],
    ['unsupported source', (m: any) => m.source = 'trained'], ['wrong coordinates', (m: any) => m.coordinateSystem = 'ENU'],
    ['wrong units', (m: any) => m.units = 'feet'], ['empty name', (m: any) => m.name = ' '],
    ['control name', (m: any) => m.name = 'bad\u0000name'], ['large name', (m: any) => m.name = 'x'.repeat(121)],
    ['zero duration', (m: any) => m.duration = 0], ['long duration', (m: any) => m.duration = 120.01],
    ['nonfinite duration', (m: any) => m.duration = Infinity], ['missing duration', (m: any) => delete m.duration],
    ['unknown field', (m: any) => m.url = 'https://example.com/frame.splat'],
    ['hostile field', (m: any) => Object.defineProperty(m, '__proto__', { value: { polluted: true }, enumerable: true })],
    ['invalid bounds vector', (m: any) => m.bounds.min = [0, 0]], ['nonfinite bounds', (m: any) => m.bounds.min[0] = NaN],
    ['excessive bounds', (m: any) => m.bounds.min[0] = -10001], ['inverted bounds', (m: any) => m.bounds.min[0] = 9],
    ['zero extent', (m: any) => m.bounds.min = [...m.bounds.max]], ['extra bounds field', (m: any) => m.bounds.constructor = {}],
    ['empty frames', (m: any) => m.frames = []], ['first frame after zero', (m: any) => m.frames[0].time = 0.01],
    ['repeated time', (m: any) => m.frames[1].time = 0], ['decreasing time', (m: any) => m.frames[2].time = 1],
    ['sample past duration', (m: any) => m.frames[2].time = 121], ['negative time', (m: any) => m.frames[0].time = -1],
    ['extra frame field', (m: any) => m.frames[0].url = '/frame.splat'], ['bad hash', (m: any) => m.frames[0].sha256 = 'z'.repeat(64)],
    ['short hash', (m: any) => m.frames[0].sha256 = 'a'.repeat(63)], ['uppercase hash', (m: any) => m.frames[0].sha256 = 'A'.repeat(64)],
    ['duplicate names', (m: any) => m.frames[1].file = m.frames[0].file], ['case duplicate', (m: any) => m.frames[1].file = m.frames[0].file.toUpperCase()],
  ])('rejects %s without mutating another validated bundle', async (_name, mutate) => {
    const good = fixture(), previous = await loadCaptureFiles(good.files()), snapshot = JSON.stringify(previous.manifest);
    const bad = fixture(); (mutate as (m: any) => void)(bad.manifest);
    await expect(loadCaptureFiles(bad.files())).rejects.toThrow();
    expect(JSON.stringify(previous.manifest)).toBe(snapshot); expect(({} as any).polluted).toBeUndefined();
  });

  it.each(['../frame.splat', 'folder/frame.splat', 'folder\\frame.splat', '/frame.splat', 'https://x/frame.splat', 'a%2fb.splat', '.hidden.splat', 'a..b.splat', 'a b.splat', 'frame.rad', 'frame.json', 'a'.repeat(129) + '.splat'])('rejects unsafe filename %s', async name => {
    const f = fixture(1); f.manifest.frames[0].file = name; f.frames[0] = new File([f.data], name);
    await expect(loadCaptureFiles(f.files())).rejects.toThrow();
  });

  it('requires exactly matching local filenames and rejects selected duplicates or extras', async () => {
    const f = fixture();
    await expect(loadCaptureFiles(f.files().slice(1))).rejects.toThrow(/capture.json/);
    await expect(loadCaptureFiles([...f.files(), f.frames[0]])).rejects.toThrow(/Duplicate/);
    await expect(loadCaptureFiles([...f.files(), new File([f.data], 'FRAME-0.SPLAT')])).rejects.toThrow(/Duplicate/);
    await expect(loadCaptureFiles([...f.files(), new File([f.data], 'extra.splat')])).rejects.toThrow(/without extras/);
    await expect(loadCaptureFiles(f.files().slice(0, -1))).rejects.toThrow(/exactly match/);
    const caseMismatch = f.files(); caseMismatch[1] = new File([f.data], 'FRAME-0.SPLAT');
    await expect(loadCaptureFiles(caseMismatch)).rejects.toThrow(/Missing selected/);
    await expect(loadCaptureFiles([{} as File, ...f.frames])).rejects.toThrow(/File handles/);
  });

  it('rejects duplicate JSON keys, including escaped aliases and nested frame hashes', async () => {
    const f = fixture(1), raw = JSON.stringify(f.manifest);
    const duplicated = [raw.replace('"version":1', '"version":0,"version":1'),
      raw.replace('"name":', '"na\\u006de":"duplicate","name":'),
      raw.replace('"sha256":', '"sha256":"' + '0'.repeat(64) + '","sha256":')];
    for (const text of duplicated) await expect(loadCaptureFiles([new File([text], 'capture.json'), ...f.frames])).rejects.toThrow(/duplicate object field/);
    f.manifest.name = 'Braces { [ \\" ] } and a colon: remain ordinary text';
    expect((await loadCaptureFiles(f.files())).manifest.name).toBe(f.manifest.name);
  });

  it('enforces manifest bytes, frame count, per-file size and combined size before decoding', async () => {
    const f = fixture(1), raw = JSON.stringify(f.manifest);
    const exact = new File([raw.padEnd(MAX_CAPTURE_MANIFEST_BYTES, ' ')], 'capture.json');
    expect((await loadCaptureFiles([exact, ...f.frames])).manifest.frames).toHaveLength(1);
    await expect(loadCaptureFiles([new File([raw.padEnd(MAX_CAPTURE_MANIFEST_BYTES + 1, ' ')], 'capture.json'), ...f.frames])).rejects.toThrow(/64 KiB/);
    await expect(loadCaptureFiles([new File([new Uint8Array([255])], 'capture.json'), ...f.frames])).rejects.toThrow();
    const maximum = fixture(240); expect((await loadCaptureFiles(maximum.files())).manifest.frames).toHaveLength(240);
    await expect(loadCaptureFiles(fixture(241).files())).rejects.toThrow(/240/);
    const oversized = new File([f.data], 'frame-0.splat'); Object.defineProperty(oversized, 'size', { value: 64 * 1024 * 1024 + 1 });
    await expect(loadCaptureFiles([f.files()[0], oversized])).rejects.toThrow(/64 MiB/);
    const total = fixture(5); total.frames.forEach(file => Object.defineProperty(file, 'size', { value: 64 * 1024 * 1024 }));
    await expect(loadCaptureFiles(total.files())).rejects.toThrow(/256 MiB/);
  });

  it('selects the rightmost sample deterministically, including the duration endpoint', async () => {
    const f = fixture(17), { manifest } = await loadCaptureFiles(f.files());
    expect(selectCaptureFrame(manifest, -100)).toBe(0); expect(selectCaptureFrame(manifest, 120)).toBe(16); expect(selectCaptureFrame(manifest, 999)).toBe(16);
    let seed = 0x10203040;
    for (let i = 0; i < 500; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; const time = seed / 2 ** 32 * 160 - 20;
      const clamped = Math.min(120, Math.max(0, time)); let expected = 0;
      manifest.frames.forEach((frame, index) => { if (frame.time <= clamped) expected = index; });
      expect(selectCaptureFrame(manifest, time)).toBe(expected);
    }
    for (const value of [NaN, Infinity, -Infinity]) expect(() => selectCaptureFrame(manifest, value)).toThrow(/finite/);
    const single = await loadCaptureFiles(fixture(1).files()); expect(selectCaptureFrame(single.manifest, 120)).toBe(0);
  });

  it('rejects forged bundles and out-of-bounds frame indices', async () => {
    const bundle = await loadCaptureFiles(fixture().files());
    for (const index of [-1, 0.5, 3, NaN, Infinity]) await expect(loadCaptureFrame(bundle, index)).rejects.toThrow(/index/);
    await expect(loadCaptureFrame({ ...bundle }, 0)).rejects.toThrow(/validate capture/);
    expect(() => selectCaptureFrame({ duration: 0, frames: [] } as unknown as CaptureManifest, 0)).toThrow();
  });
});
