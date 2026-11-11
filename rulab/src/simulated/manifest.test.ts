import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  assertRolloutBundle, loadRolloutFiles, openRollout, parseRolloutIndex, parseRolloutIndexText, parseRolloutManifest, verifiedRollout, verifyRollout,
  MAX_ROLLOUT_MANIFEST_BYTES,
} from './manifest';

const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const MIB = 1024 * 1024;

/** An in-memory rollout whose manifest agrees with its bytes. `mutate` then breaks exactly one rule. */
function fixture(options: { firstFrame?: boolean; mutate?: (manifest: any) => void } = {}) {
  const clip = new Uint8Array(96).map((_, i) => (i * 7) % 251), caption = new TextEncoder().encode('{"prompt":"door opens"}\n');
  const first = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
  const manifest: any = {
    format: 'worldgraph.simulated.rollout', version: 1, name: 'RF door opens', simulated: true,
    media: { file: 'clip.mp4', sha256: sha(clip), bytes: clip.length, mediaType: 'video/mp4', width: 1248, height: 704, fps: 24, durationSec: 5 },
    caption: { file: 'caption.json', sha256: sha(caption), bytes: caption.length },
    envelope: { schema_version: 1, session_id: 'pan2-7', epoch: 3, sequence: 9, chunk: {
      frames: [{ transport: 'file', locator: 'clip.mp4', content_hash: `sha256:${sha(clip)}`, byte_length: clip.length, media_type: 'video/mp4' }],
      provenance: { provider: 'pan2', model: 'PAN-2', checkpoint: 'ckpt-a1', runtime_version: '0.3.1', source_snapshot_hash: 'sha256:' + 'ab'.repeat(32), source_stream_epoch: 4,
        prompt_action_hash: 'sha256:' + 'cd'.repeat(32), generation_seed: 1234, generation_sequence: 9, simulated: true, confidence: 0.4,
        privacy: { projection_id: 'lab-geometry-v2', hosted_processing_approved: false, redactions_applied: 2, retention: 'ephemeral' },
        license: { license_id: 'Apache-2.0', usage: 'production', redistribution_allowed: true, attribution_required: true, notice: null } } } },
    generation: { hardware: '1x H200 NVL 140GB', steps: 50, seconds: 412.5, peakVramGb: 96.2 },
  };
  if (options.firstFrame) manifest.firstFrame = { file: 'first.png', sha256: sha(first), bytes: first.length };
  options.mutate?.(manifest);
  const media = () => [new File([clip], manifest.media.file), new File([caption], manifest.caption.file), ...(options.firstFrame ? [new File([first], manifest.firstFrame.file)] : [])];
  const files = (text = JSON.stringify(manifest)) => [new File([text], 'rollout.json'), ...media()];
  return { clip, caption, first, manifest, media, files };
}
const rejects = (mutate: (manifest: any) => void, message: RegExp, firstFrame = false) =>
  expect(() => parseRolloutManifest(fixture({ firstFrame, mutate }).manifest), String(message)).toThrow(message);
const provenance = (manifest: any) => manifest.envelope.chunk.provenance;

describe('simulated rollout manifest contract', () => {
  it('accepts the bundled synthetic fixture and its index, and verifies every file hash', async () => {
    const directory = resolve('public/simulated/synthetic-example');
    const files = await Promise.all(['rollout.json', 'clip.mp4', 'caption.json'].map(async name => new File([new Uint8Array(await readFile(resolve(directory, name)))], name)));
    const bundle = await loadRolloutFiles(files), source = bundle.manifest.envelope.chunk.provenance;
    expect(bundle.manifest.name).toBe('Synthetic test pattern (not model output)');
    expect(source).toMatchObject({ provider: 'mock', model: 'deterministic-fixture', simulated: true, generation_seed: '0' });
    expect(bundle.manifestSha256).toBe(sha(await readFile(resolve(directory, 'rollout.json'))));
    const checked = await verifyRollout(bundle), clip = await readFile(resolve(directory, 'clip.mp4'));
    expect(checked.mediaSha256).toBe(sha(clip)); expect(checked.media.type).toBe('video/mp4');
    expect(new Uint8Array(await checked.media.arrayBuffer())).toEqual(new Uint8Array(clip));
    expect(String.fromCharCode(...clip.subarray(4, 8))).toBe('ftyp');
    expect(JSON.parse(checked.captionText).note).toContain('No world model was prompted');
    expect(parseRolloutIndexText(await readFile(resolve('public/simulated/index.json'), 'utf8'))).toContainEqual({ id: 'synthetic-example', path: 'synthetic-example/rollout.json' });
  });

  it('returns a deeply frozen manifest with only known fields and boundary values', async () => {
    const f = fixture({ firstFrame: true, mutate: m => { Object.assign(m.media, { width: 16, height: 4096, fps: 120, durationSec: 20 }); m.name = 'n'.repeat(120); m.generation = {}; m.envelope.future_field = 1; provenance(m).extra = 'tolerated'; } });
    const bundle = await loadRolloutFiles(f.files());
    expect(Object.isFrozen(bundle)).toBe(true); expect(Object.isFrozen(bundle.manifest.media)).toBe(true); expect(Object.isFrozen(bundle.manifest.envelope.chunk.frames)).toBe(true);
    expect(() => { (bundle.manifest.envelope.chunk.provenance as any).simulated = false; }).toThrow();
    expect(bundle.manifest.envelope).not.toHaveProperty('future_field'); expect(bundle.manifest.envelope.chunk.provenance).not.toHaveProperty('extra');
    expect(bundle.manifest.firstFrame?.file).toBe('first.png'); expect(bundle.manifest.generation).toEqual({}); expect(bundle.origin).toBe('local');
    expect(parseRolloutManifest(fixture({ mutate: m => { delete m.generation; m.media.fps = 1; m.media.file = 'Clip_01.take-2.MP4'; } }).manifest)).not.toHaveProperty('generation');
    expect(parseRolloutManifest(fixture({ firstFrame: true, mutate: m => { m.firstFrame.file = 'first.JPEG'; delete provenance(m).license.notice; } }).manifest).envelope.chunk.provenance.license.notice).toBeNull();
  });

  it('requires the exact format, version and both simulated markers', () => {
    rejects(m => { m.format = 'worldgraph.rulab.capture'; }, /format must be exactly "worldgraph\.simulated\.rollout"/);
    rejects(m => { m.format = 'worldgraph.simulated.rollout.v2'; }, /format must be exactly/);
    for (const version of [2, '1', 1.5, null]) rejects(m => { m.version = version; }, /only version 1/);
    for (const simulated of [false, 'true', 1, null]) rejects(m => { m.simulated = simulated; }, /"simulated" must be literally true/);
    for (const simulated of [false, 'true', 1, undefined]) rejects(m => { provenance(m).simulated = simulated; }, /provenance\.simulated must be literally true/);
  });

  it('rejects unknown and missing fields in every closed object', () => {
    rejects(m => { m.source = 'observed'; }, /Rollout manifest has an unsupported field: "source"/);
    rejects(m => { m.frames = []; }, /unsupported field: "frames"/);
    rejects(m => { m.media.codec = 'h264'; }, /media has an unsupported field: "codec"/);
    rejects(m => { m.caption.text = 'x'; }, /caption has an unsupported field: "text"/);
    rejects(m => { m.firstFrame.width = 4; }, /firstFrame has an unsupported field: "width"/, true);
    rejects(m => { m.generation.cost = 3; }, /generation has an unsupported field: "cost"/);
    for (const key of ['format', 'version', 'name', 'simulated', 'media', 'caption', 'envelope']) rejects(m => { delete m[key]; }, new RegExp(`missing the required field "${key}"`));
    for (const key of ['file', 'sha256', 'bytes', 'mediaType', 'width', 'height', 'fps', 'durationSec']) rejects(m => { delete m.media[key]; }, new RegExp(`media is missing the required field "${key}"`));
    rejects(m => { delete m.caption.sha256; }, /caption is missing the required field "sha256"/);
    rejects(m => { m.media = []; }, /media must be a JSON object/); rejects(m => { m.envelope = null; }, /envelope must be a JSON object/);
    expect(() => parseRolloutManifest(Object.assign(Object.create({ inherited: 1 }), fixture().manifest))).toThrow(/must be a JSON object/);
  });

  it('validates the name', () => {
    expect(parseRolloutManifest(fixture({ mutate: m => { m.name = '🚪'.repeat(120); } }).manifest).name).toHaveLength(240);
    for (const name of ['', '🚪'.repeat(121), ' padded', 'padded ', 'n'.repeat(121), 'tab\there', 'bell\x07', 'del\x7f', 7]) rejects(m => { m.name = name; }, /name must contain 1–120 trimmed characters/);
  });

  it('accepts only flat ASCII filenames with the required extension', () => {
    for (const file of ['dir/clip.mp4', '../clip.mp4', '.clip.mp4', 'clip..mp4', 'cl ip.mp4', 'clïp.mp4', 'C:\\clip.mp4', 'https://x/clip.mp4', `${'a'.repeat(125)}.mp4`, 5])
      rejects(m => { m.media.file = file; }, /media\.file must be a flat ASCII filename/);
    for (const file of ['clip.webm', 'clip.mp4.json', 'clip']) rejects(m => { m.media.file = file; }, /media\.file must end with \.mp4/);
    rejects(m => { m.caption.file = 'caption.txt'; }, /caption\.file must end with \.json/);
    rejects(m => { m.caption.file = 'sub/caption.json'; }, /caption\.file must be a flat ASCII filename/);
    for (const file of ['first.gif', 'first.webp', 'first.png.mp4']) rejects(m => { m.firstFrame.file = file; }, /firstFrame\.file must end with \.png, \.jpg, \.jpeg/, true);
    rejects(m => { m.caption.file = 'rollout.json'; }, /distinct ignoring case and must not reuse rollout\.json/);
    rejects(m => { m.caption.file = 'ROLLOUT.JSON'; }, /distinct ignoring case/);
  });

  it('bounds media type, byte counts and hashes', () => {
    for (const mediaType of ['video/webm', 'VIDEO/MP4', 'video/mp4; codecs=avc1', null]) rejects(m => { m.media.mediaType = mediaType; }, /mediaType must be exactly "video\/mp4"/);
    for (const bytes of [0, -1, 1.5, '96', 2 ** 53, null]) rejects(m => { m.media.bytes = bytes; }, /media\.bytes must be a positive safe integer/);
    rejects(m => { m.media.bytes = 64 * MIB + 1; }, /media\.bytes exceeds the 64 MiB limit/);
    rejects(m => { m.caption.bytes = 64 * 1024 + 1; }, /caption\.bytes exceeds the 64 KiB limit/);
    rejects(m => { m.firstFrame.bytes = 8 * MIB + 1; }, /firstFrame\.bytes exceeds the 8 MiB limit/, true);
    rejects(m => { m.caption.bytes = 0; }, /caption\.bytes must be a positive safe integer/);
    const atLimit = fixture({ firstFrame: true, mutate: m => { m.media.bytes = 64 * MIB; m.envelope.chunk.frames[0].byte_length = 64 * MIB; m.caption.bytes = 64 * 1024; m.firstFrame.bytes = 8 * MIB; } });
    expect(parseRolloutManifest(atLimit.manifest).media.bytes).toBe(64 * MIB);
    for (const hash of ['A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), `sha256:${'a'.repeat(57)}`, 12]) {
      rejects(m => { m.media.sha256 = hash; }, /media\.sha256 must contain 64 lowercase hexadecimal/);
      rejects(m => { m.caption.sha256 = hash; }, /caption\.sha256 must contain 64 lowercase hexadecimal/);
      rejects(m => { m.firstFrame.sha256 = hash; }, /firstFrame\.sha256 must contain 64 lowercase hexadecimal/, true);
    }
  });

  it('bounds dimensions, frame rate and duration', () => {
    for (const value of [15, 4097, 16.5, '1248', -704, null]) {
      rejects(m => { m.media.width = value; }, /media\.width must be an integer from 16 to 4096/);
      rejects(m => { m.media.height = value; }, /media\.height must be an integer from 16 to 4096/);
    }
    for (const fps of [0, 0.99, 120.01, -24, '24', Infinity, NaN, null]) rejects(m => { m.media.fps = fps; }, /media\.fps must be from 1 to 120/);
    for (const duration of [0, -1, 20.001, Infinity, NaN, '5', null]) rejects(m => { m.media.durationSec = duration; }, /media\.durationSec must be greater than zero and at most 20/);
    expect(parseRolloutManifest(fixture({ mutate: m => { m.media.fps = 23.976; m.media.durationSec = 0.04; } }).manifest).media.fps).toBe(23.976);
  });

  it('validates optional measured generation statistics', () => {
    rejects(m => { m.generation.hardware = 7; }, /generation\.hardware must be a string/);
    rejects(m => { m.generation.hardware = 'x'.repeat(513); }, /generation\.hardware must be a string of at most 512/);
    for (const steps of [1.5, -3, '50', 2 ** 32]) rejects(m => { m.generation.steps = steps; }, /generation\.steps must be an integer/);
    for (const key of ['seconds', 'peakVramGb']) for (const value of [-1, Infinity, '1', null]) rejects(m => { m.generation[key] = value; }, new RegExp(`generation\\.${key} must be a finite, non-negative measurement`));
    rejects(m => { m.generation = []; }, /generation must be a JSON object/);
    expect(parseRolloutManifest(fixture({ mutate: m => { m.generation = { seconds: 0 }; } }).manifest).generation).toEqual({ seconds: 0 });
  });

  it('binds the first video/mp4 envelope frame to the media hash and length', () => {
    const frame = (m: any) => m.envelope.chunk.frames[0];
    rejects(m => { frame(m).content_hash = `sha256:${'0'.repeat(64)}`; }, /content_hash does not equal "sha256:" \+ media\.sha256/);
    rejects(m => { frame(m).content_hash = m.media.sha256; }, /content_hash does not equal/);
    rejects(m => { frame(m).byte_length = m.media.bytes + 1; }, /byte_length does not equal media\.bytes/);
    rejects(m => { frame(m).media_type = 'video/av1'; }, /no video\/mp4 frame descriptor/);
    rejects(m => { m.envelope.chunk.frames = []; }, /must list 1–1024 frame descriptors/);
    rejects(m => { m.envelope.chunk.frames = Array.from({ length: 1025 }, () => frame(m)); }, /must list 1–1024 frame descriptors/);
    rejects(m => { m.envelope.chunk.frames = {}; }, /must list 1–1024 frame descriptors/);
    // Only the first video/mp4 descriptor counts: a later matching one cannot rescue a mismatched first.
    rejects(m => { m.envelope.chunk.frames.unshift({ ...frame(m), content_hash: `sha256:${'1'.repeat(64)}` }); }, /content_hash does not equal/);
    const skipped = fixture({ mutate: m => { m.envelope.chunk.frames.unshift({ transport: 'file', locator: 'first.png', content_hash: 'sha256:other', byte_length: 5, media_type: 'image/png' }); } });
    expect(parseRolloutManifest(skipped.manifest).envelope.chunk.frames).toHaveLength(2);
  });

  it('type-checks the snake_case envelope fields it relies on', () => {
    rejects(m => { m.envelope.schema_version = 2; }, /envelope\.schema_version must be 1/);
    rejects(m => { m.envelope.session_id = 7; }, /envelope\.session_id must be a string/);
    rejects(m => { delete m.envelope.chunk; }, /envelope\.chunk must be a JSON object/);
    for (const key of ['provider', 'model', 'checkpoint', 'runtime_version', 'source_snapshot_hash', 'prompt_action_hash']) {
      rejects(m => { delete provenance(m)[key]; }, new RegExp(`provenance\\.${key} must be a string`));
      rejects(m => { provenance(m)[key] = 'x'.repeat(4097); }, new RegExp(`provenance\\.${key} must be a string of at most 4096`));
    }
    for (const confidence of [-0.1, 1.1, '0.5', null]) rejects(m => { provenance(m).confidence = confidence; }, /confidence must be from 0 to 1/);
    rejects(m => { provenance(m).privacy.retention = 'forever'; }, /retention must be "ephemeral" or "policy_bound"/);
    rejects(m => { provenance(m).privacy.hosted_processing_approved = 'no'; }, /hosted_processing_approved must be true or false/);
    rejects(m => { provenance(m).privacy.redactions_applied = -1; }, /redactions_applied must be an integer/);
    rejects(m => { provenance(m).license.usage = 'commercial'; }, /usage must be "production" or "research_only"/);
    rejects(m => { provenance(m).license.license_id = null; }, /license_id must be a string/);
    // The Rust writer bounds none of these strings, so a multi-line notice or an empty hash is accepted and only ever shown as text.
    const loose = parseRolloutManifest(fixture({ mutate: m => { provenance(m).license.notice = 'line one\nline two'; provenance(m).source_snapshot_hash = ''; m.generation = { hardware: '', steps: 0 }; } }).manifest);
    expect(loose.envelope.chunk.provenance.license.notice).toBe('line one\nline two'); expect(loose.generation).toEqual({ hardware: '', steps: 0 });
    rejects(m => { delete provenance(m).license; }, /provenance\.license must be a JSON object/);
  });

  it('keeps unsigned 64-bit integers exact instead of rounding them', async () => {
    const text = (seed: string) => JSON.stringify(fixture().manifest).replace('"generation_seed":1234', `"generation_seed":${seed}`);
    const bundle = await loadRolloutFiles(fixture().files(text('18446744073709551615')));
    expect(bundle.manifest.envelope.chunk.provenance.generation_seed).toBe('18446744073709551615');
    expect((await loadRolloutFiles(fixture().files(text('9007199254740993')))).manifest.envelope.chunk.provenance.generation_seed).toBe('9007199254740993');
    await expect(loadRolloutFiles(fixture().files(text('18446744073709551616')))).rejects.toThrow(/generation_seed must be an unsigned 64-bit integer/);
    await expect(loadRolloutFiles(fixture().files(text('1e30')))).rejects.toThrow(/generation_seed is too large for this browser to read exactly/);
    for (const seed of ['-1', '1.5', '"7"', 'null']) await expect(loadRolloutFiles(fixture().files(text(seed)))).rejects.toThrow(/generation_seed must be an unsigned 64-bit integer/);
    // A parsed value that already lost precision is refused rather than displayed rounded.
    rejects(m => { provenance(m).generation_seed = 2 ** 60; }, /too large for this browser to read exactly/);
    rejects(m => { m.envelope.epoch = -1; }, /envelope\.epoch must be an unsigned 64-bit integer/);
    rejects(m => { m.envelope.chunk.frames[0].byte_length = 1.5; }, /byte_length must be an unsigned 64-bit integer/);
  });
});

describe('rollout.json text and local file selection', () => {
  it('rejects duplicate keys, including escaped aliases and nested envelope fields', async () => {
    const base = JSON.stringify(fixture().manifest);
    const cases = [
      base.replace('"version":1', '"version":2,"version":1'),
      base.replace('"simulated":true', '"simulated":false,"\\u0073imulated":true'),
      base.replace('"mediaType":"video/mp4"', '"mediaType":"video/webm","mediaType":"video/mp4"'),
      base.replace('"provider":"pan2"', '"provider":"real-camera","provider":"pan2"'),
    ];
    for (const text of cases) { expect(text).not.toBe(base); await expect(loadRolloutFiles(fixture().files(text))).rejects.toThrow(/duplicate object field/); }
    // The same key in sibling objects, or key-like text inside a string value, is not a duplicate.
    const benign = fixture({ mutate: m => { m.name = 'say "name": twice {'; } });
    expect((await loadRolloutFiles(benign.files())).manifest.name).toBe('say "name": twice {');
  });

  it('bounds and decodes the manifest before parsing', async () => {
    const f = fixture();
    await expect(loadRolloutFiles(f.files(JSON.stringify(f.manifest) + ' '.repeat(MAX_ROLLOUT_MANIFEST_BYTES)))).rejects.toThrow(/between 1 byte and 64 KiB/);
    await expect(loadRolloutFiles([new File([], 'rollout.json'), ...f.media()])).rejects.toThrow(/between 1 byte and 64 KiB/);
    await expect(loadRolloutFiles(f.files('{"format":'))).rejects.toThrow(/rollout\.json is not valid JSON/);
    await expect(loadRolloutFiles([new File([new Uint8Array([0xff, 0xfe, 0x7b])], 'rollout.json'), ...f.media()])).rejects.toThrow(/rollout\.json is not valid UTF-8/);
    await expect(loadRolloutFiles(f.files('[]'))).rejects.toThrow(/Rollout manifest must be a JSON object/);
    const padded = '﻿ \n' + JSON.stringify(f.manifest, null, 2) + '\n', bundle = await loadRolloutFiles(f.files(padded));
    expect(bundle.manifestSha256).toBe(sha(padded)); expect(bundle.manifestSha256).not.toBe(sha(JSON.stringify(f.manifest)));
  });

  it('requires the selection to match the manifest exactly', async () => {
    const f = fixture({ firstFrame: true }), all = f.files();
    expect((await loadRolloutFiles(all)).manifest.firstFrame?.bytes).toBe(f.first.length);
    await expect(loadRolloutFiles(all.slice(0, 3))).rejects.toThrow(/exactly match the rollout manifest/);
    await expect(loadRolloutFiles(all.slice(1))).rejects.toThrow(/named exactly rollout\.json/);
    await expect(loadRolloutFiles([all[0], all[1]])).rejects.toThrow(/Select rollout\.json together with/);
    await expect(loadRolloutFiles([...all, new File(['x'], 'extra.mp4')])).rejects.toThrow(/Select rollout\.json together with/);
    const plain = fixture();
    await expect(loadRolloutFiles([...plain.files(), new File(['x'], 'extra.png')])).rejects.toThrow(/exactly match the rollout manifest/);
    await expect(loadRolloutFiles([plain.files()[0], new File([plain.clip], 'CLIP.mp4'), plain.media()[1]])).rejects.toThrow(/Missing selected rollout file: clip\.mp4/);
    await expect(loadRolloutFiles([...plain.files().slice(0, 2), new File(['x'], 'Clip.MP4')])).rejects.toThrow(/Duplicate selected filename/);
    await expect(loadRolloutFiles([new File(['{}'], 'Rollout.json'), ...plain.media()])).rejects.toThrow(/named exactly rollout\.json/);
    await expect(loadRolloutFiles([plain.files()[0], new File([plain.clip.slice(1)], 'clip.mp4'), plain.media()[1]])).rejects.toThrow(/Byte length mismatch for clip\.mp4: the manifest declares 96, the selected file has 95/);
    await expect(loadRolloutFiles([plain.files()[0], { name: 'clip.mp4', size: 96 } as File, plain.media()[1]])).rejects.toThrow(/local File handles/);
    await expect(loadRolloutFiles('rollout.json' as unknown as File[])).rejects.toThrow(/Select rollout\.json/);
    // A capture bundle is not a rollout, whatever it is named.
    const capture = JSON.stringify({ format: 'worldgraph.rulab.capture', version: 1, name: 'x', source: 'observed', coordinateSystem: 'right-handed-y-up', units: 'metres', duration: 1, bounds: {}, frames: [] });
    await expect(loadRolloutFiles(plain.files(capture))).rejects.toThrow(/unsupported field|A capture manifest is not a rollout/);
  });
});

describe('SHA-256 verification before anything is shown', () => {
  const corrupt = (bytes: Uint8Array) => { const copy = bytes.slice(); copy[0] ^= 0xff; return copy; };

  it('returns Blobs of the exact verified byte snapshots and reads each source once', async () => {
    const f = fixture({ firstFrame: true }), files = f.files();
    const reads = files.map(file => vi.spyOn(file, 'arrayBuffer')), fetchSpy = vi.spyOn(globalThis, 'fetch');
    const bundle = await loadRolloutFiles(files);
    expect(verifiedRollout(bundle)).toBeNull();
    const checked = await verifyRollout(bundle);
    expect(new Uint8Array(await checked.media.arrayBuffer())).toEqual(f.clip); expect(checked.media.type).toBe('video/mp4');
    expect(checked.captionText).toBe('{"prompt":"door opens"}\n'); expect(checked.captionSha256).toBe(sha(f.caption));
    expect(new Uint8Array(await checked.firstFrame!.arrayBuffer())).toEqual(f.first); expect(checked.firstFrame!.type).toBe('image/png'); expect(checked.firstFrameSha256).toBe(sha(f.first));
    expect(checked.mediaSha256).toBe(sha(f.clip)); expect(Object.isFrozen(checked)).toBe(true);
    expect(verifiedRollout(bundle)).toBe(checked); expect(await verifyRollout(bundle)).toBe(checked);
    expect(reads.map(read => read.mock.calls.length)).toEqual([1, 1, 1, 1]); expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    const without = await verifyRollout(await loadRolloutFiles(fixture().files()));
    expect(without.firstFrame).toBeNull(); expect(without.firstFrameSha256).toBeNull();
  });

  it('rejects a hash mismatch in the video, caption or first frame and records nothing as verified', async () => {
    const f = fixture({ firstFrame: true }), [manifest, clip, caption, first] = f.files();
    const variants: Array<[string, File[]]> = [
      ['clip.mp4', [manifest, new File([corrupt(f.clip)], 'clip.mp4'), caption, first]],
      ['caption.json', [manifest, clip, new File([corrupt(f.caption)], 'caption.json'), first]],
      ['first.png', [manifest, clip, caption, new File([corrupt(f.first)], 'first.png')]],
    ];
    for (const [name, files] of variants) {
      const bundle = await loadRolloutFiles(files);
      await expect(verifyRollout(bundle)).rejects.toThrow(new RegExp(`SHA-256 mismatch for ${name.replace('.', '\\.')}\\. The rollout will not be played`));
      expect(verifiedRollout(bundle)).toBeNull();
    }
    const declared = fixture({ mutate: m => { m.media.sha256 = '0'.repeat(64); m.envelope.chunk.frames[0].content_hash = `sha256:${'0'.repeat(64)}`; } });
    await expect(verifyRollout(await loadRolloutFiles(declared.files()))).rejects.toThrow(/SHA-256 mismatch for clip\.mp4/);
  });

  it('rejects length mismatches and unvalidated bundles, and shows a verified caption as text whatever it contains', async () => {
    const f = fixture(), text = new TextEncoder().encode(JSON.stringify(f.manifest));
    const reader = (clip: Uint8Array, caption: Uint8Array = f.caption) => async (name: string, maxBytes: number) => {
      const bytes = name === 'rollout.json' ? text : name === 'clip.mp4' ? clip : caption;
      if (bytes.byteLength > maxBytes) throw new RangeError(`${name} exceeds its ${maxBytes} byte limit.`);
      return bytes.slice().buffer;
    };
    const short = await openRollout(reader(f.clip.slice(0, 90)), 'bundled');
    expect(short.origin).toBe('bundled');
    await expect(verifyRollout(short)).rejects.toThrow(/Byte length mismatch for clip\.mp4: the manifest declares 96, received 90/);
    expect(verifiedRollout(short)).toBeNull();
    expect((await verifyRollout(await openRollout(reader(f.clip), 'bundled'))).mediaSha256).toBe(sha(f.clip));
    const notJson = new TextEncoder().encode('door opens, not json\n');
    const bad = fixture({ mutate: m => { m.caption = { file: 'caption.json', sha256: sha(notJson), bytes: notJson.length }; } });
    expect((await verifyRollout(await loadRolloutFiles([bad.files()[0], bad.media()[0], new File([notJson], 'caption.json')]))).captionText).toBe('door opens, not json\n');
    const binary = new Uint8Array([0xff, 0xfe, 0x00]), garbled = fixture({ mutate: m => { m.caption = { file: 'caption.json', sha256: sha(binary), bytes: 3 }; } });
    await expect(verifyRollout(await loadRolloutFiles([garbled.files()[0], garbled.media()[0], new File([binary], 'caption.json')]))).rejects.toThrow(/caption\.json is not valid UTF-8/);
    const bundle = await loadRolloutFiles(f.files());
    expect(() => assertRolloutBundle({ ...bundle })).toThrow(/Load and validate rollout files/);
    await expect(verifyRollout({ ...bundle })).rejects.toThrow(/Load and validate rollout files/);
    expect(() => verifiedRollout(null as any)).toThrow(/Load and validate rollout files/);
  });
});

describe('bundled rollout index', () => {
  const index = (rollouts: unknown, extra: object = {}) => ({ format: 'worldgraph.simulated.index', version: 1, rollouts, ...extra });
  const entry = (id: string, path = `${id}/rollout.json`) => ({ id, path });

  it('accepts empty and well-formed indexes', () => {
    expect(parseRolloutIndex(index([]))).toEqual([]);
    const entries = parseRolloutIndex(index([entry('rf-door'), entry('a'), entry('x'.repeat(48)), entry('2026-pan2-run-07')]));
    expect(entries.map(item => item.id)).toEqual(['rf-door', 'a', 'x'.repeat(48), '2026-pan2-run-07']); expect(Object.isFrozen(entries)).toBe(true);
    expect(parseRolloutIndex(index(Array.from({ length: 16 }, (_, i) => entry(`r${i}`))))).toHaveLength(16);
  });

  it('rejects malformed ids, paths, counts and unknown fields', () => {
    for (const id of ['', 'RF-door', 'rf_door', 'rf door', 'rf/door', '..', 'x'.repeat(49), 'é', 7]) expect(() => parseRolloutIndex(index([{ id, path: `${id}/rollout.json` }])), String(id)).toThrow(/id must be 1–48 lowercase letters, digits or hyphens/);
    for (const path of ['rf-door/Rollout.json', 'rf-door/../other/rollout.json', '/rf-door/rollout.json', 'rf-door/rollout.json?x', 'other/rollout.json', 'rollout.json', 'https://example.invalid/rf-door/rollout.json'])
      expect(() => parseRolloutIndex(index([entry('rf-door', path)])), path).toThrow(/path must be exactly "rf-door\/rollout\.json"/);
    expect(() => parseRolloutIndex(index(Array.from({ length: 17 }, (_, i) => entry(`r${i}`))))).toThrow(/at most 16 rollouts/);
    expect(() => parseRolloutIndex(index([entry('a'), entry('a')]))).toThrow(/more than once/);
    expect(() => parseRolloutIndex(index([{ ...entry('a'), name: 'A' }]))).toThrow(/unsupported field: "name"/);
    expect(() => parseRolloutIndex(index([], { generatedAt: 'now' }))).toThrow(/unsupported field: "generatedAt"/);
    expect(() => parseRolloutIndex(index({}))).toThrow(/at most 16 rollouts/);
    expect(() => parseRolloutIndex({ ...index([]), version: 2 })).toThrow(/format "worldgraph\.simulated\.index" and version 1/);
    expect(() => parseRolloutIndex({ ...index([]), format: 'worldgraph.simulated.rollout' })).toThrow(/format "worldgraph\.simulated\.index"/);
    expect(() => parseRolloutIndexText('{"format":"worldgraph.simulated.index","version":1,"rollouts":[],"rollouts":[]}')).toThrow(/duplicate object field/);
  });
});
