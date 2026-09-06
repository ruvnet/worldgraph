import { preflightSplat, validateSplatFileEnvelope, MAX_SPLAT_FILE_BYTES } from '../render/imports';
import type { CaptureBundle, CaptureFrame, CaptureManifest } from './types';

export const MAX_CAPTURE_MANIFEST_BYTES = 64 * 1024;
export const MAX_CAPTURE_FRAMES = 240;
export const MAX_CAPTURE_TOTAL_BYTES = 256 * 1024 * 1024;
export const MAX_CAPTURE_DURATION = 120;

/** A frozen Map still exposes set/delete; this facade never exposes those operations. */
class FileTable implements ReadonlyMap<string, File> {
  readonly #entries: Map<string, File>;
  constructor(entries: Map<string, File>) { this.#entries = new Map(entries); Object.freeze(this); }
  get size() { return this.#entries.size; }
  get(key: string) { return this.#entries.get(key); }
  has(key: string) { return this.#entries.has(key); }
  entries() { return this.#entries.entries(); }
  keys() { return this.#entries.keys(); }
  values() { return this.#entries.values(); }
  [Symbol.iterator]() { return this.entries(); }
  forEach(callback: (value: File, key: string, map: ReadonlyMap<string, File>) => void, thisArg?: unknown) {
    this.#entries.forEach((value, key) => callback.call(thisArg, value, key, this));
  }
}

// Only validated bundles and successfully hashed/preflighted frames enter this registry.
const verified = new WeakMap<CaptureBundle, Set<number>>();
const manifestSnapshots = new WeakMap<CaptureBundle, Blob>();
export function assertCaptureBundle(value: unknown): asserts value is CaptureBundle {
  if (!value || typeof value !== 'object' || !verified.has(value as CaptureBundle)) throw new TypeError('Load and validate capture files before using this bundle.');
}

function object(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError(`${label} must be a plain object.`);
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) throw new TypeError(`${label} has missing or unsupported fields.`);
  return value as Record<string, unknown>;
}
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
function safeFrameName(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 128 && /^[a-z0-9][a-z0-9_-]*(?:\.[a-z0-9_-]+)*\.(?:ply|splat|spz)$/i.test(value);
}
function vector(value: unknown): readonly [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3 || value.some(v => !finite(v) || Math.abs(v) > 10_000)) throw new TypeError('Capture bounds require three finite coordinates within 10,000 metres.');
  return Object.freeze([value[0], value[1], value[2]]) as readonly [number, number, number];
}
/** Native JSON parsing is bounded by the file limit; additionally reject ambiguous duplicate keys. */
function uniqueKeyJson(text: string): unknown {
  const parsed: unknown = JSON.parse(text);
  const objects: Array<Set<string> | null> = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') objects.push(new Set());
    else if (text[i] === '[') objects.push(null);
    else if (text[i] === '}' || text[i] === ']') objects.pop();
    else if (text[i] === '"') {
      const start = i++;
      while (text[i] !== '"') { if (text[i] === '\\') i++; i++; }
      let next = i + 1; while (/\s/.test(text[next] ?? '') && next < text.length) next++;
      if (text[next] === ':') {
        const key = JSON.parse(text.slice(start, i + 1)) as string, keys = objects.at(-1)!;
        if (keys!.has(key)) throw new TypeError('Capture JSON contains a duplicate object field.');
        keys!.add(key);
      }
    }
  }
  return parsed;
}
function parseManifest(value: unknown): CaptureManifest {
  const root = object(value, ['format', 'version', 'name', 'source', 'coordinateSystem', 'units', 'duration', 'bounds', 'frames'], 'Capture manifest');
  if (root.format !== 'worldgraph.rulab.capture' || root.version !== 1 || root.coordinateSystem !== 'right-handed-y-up' || root.units !== 'metres') throw new TypeError('Unsupported capture format, version or coordinate convention.');
  if (typeof root.name !== 'string' || !root.name.trim() || root.name.length > 120 || root.name !== root.name.trim() || /[\x00-\x1f\x7f]/.test(root.name)) throw new TypeError('Capture name must contain 1–120 printable characters.');
  if (!['synthetic', 'observed', 'reconstructed'].includes(root.source as string)) throw new TypeError('Capture source must be synthetic, observed or reconstructed.');
  if (!finite(root.duration) || root.duration <= 0 || root.duration > MAX_CAPTURE_DURATION) throw new RangeError('Capture duration must be greater than zero and at most 120 seconds.');
  const duration = root.duration;
  const boundsObject = object(root.bounds, ['min', 'max'], 'Capture bounds');
  const min = vector(boundsObject.min), max = vector(boundsObject.max);
  if (min.some((v, i) => v > max[i]) || min.every((v, i) => v === max[i])) throw new RangeError('Capture bounds must be ordered and have positive extent.');
  if (!Array.isArray(root.frames) || root.frames.length < 1 || root.frames.length > MAX_CAPTURE_FRAMES) throw new RangeError('Captures require 1–240 frames.');
  const names = new Set<string>(); let previousTime = -1;
  const frames = root.frames.map((value, index): CaptureFrame => {
    const frame = object(value, ['time', 'file', 'sha256'], 'Capture frame');
    // Inclusive endpoint: a sample exactly at duration is shown when seeking to the end.
    if (!finite(frame.time) || frame.time < 0 || frame.time > duration || frame.time <= previousTime || (index === 0 && frame.time !== 0)) throw new RangeError('Frame times must begin at zero, strictly increase and not exceed duration.');
    if (!safeFrameName(frame.file)) throw new TypeError('Frame filenames must be flat ASCII PLY, SPLAT or SPZ names without paths.');
    const folded = frame.file.toLowerCase();
    if (names.has(folded)) throw new TypeError('Duplicate capture frame filename.');
    if (typeof frame.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(frame.sha256)) throw new TypeError('Frame SHA-256 must contain 64 lowercase hexadecimal characters.');
    names.add(folded); previousTime = frame.time;
    return Object.freeze({ time: frame.time, file: frame.file, sha256: frame.sha256 });
  });
  return Object.freeze({ format: root.format, version: 1, name: root.name, source: root.source as CaptureManifest['source'], coordinateSystem: root.coordinateSystem, units: root.units, duration: root.duration,
    bounds: Object.freeze({ min, max }), frames: Object.freeze(frames) });
}
async function digest(bytes: ArrayBuffer): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('SHA-256 verification requires a secure browser context.');
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('');
}

/** All validation finishes before a new immutable bundle is returned; no live player is mutated. */
export async function loadCaptureFiles(files: readonly File[]): Promise<CaptureBundle> {
  if (!Array.isArray(files) || files.length < 2 || files.length > MAX_CAPTURE_FRAMES + 1) throw new RangeError('Select capture.json and 1–240 frame files.');
  const selected = new Map<string, File>(), folded = new Set<string>(); let total = 0;
  for (const file of files) {
    if (!(file instanceof File)) throw new TypeError('Captures require local File handles.');
    if (folded.has(file.name.toLowerCase())) throw new TypeError('Duplicate selected filename, ignoring case.');
    folded.add(file.name.toLowerCase());
    if (file.name === 'capture.json') {
      if (file.size < 1 || file.size > MAX_CAPTURE_MANIFEST_BYTES) throw new RangeError('capture.json must be between 1 byte and 64 KiB.');
    } else {
      if (!safeFrameName(file.name)) throw new TypeError('Only capture.json and flat PLY, SPLAT or SPZ frame filenames are accepted.');
      validateSplatFileEnvelope(file); total += file.size;
      if (total > MAX_CAPTURE_TOTAL_BYTES) throw new RangeError('Capture frames exceed the 256 MiB total limit.');
    }
    selected.set(file.name, file);
  }
  const manifestFile = selected.get('capture.json');
  if (!manifestFile) throw new TypeError('Select the manifest named exactly capture.json.');
  const manifestBytes = await manifestFile.arrayBuffer();
  if (manifestBytes.byteLength !== manifestFile.size || manifestBytes.byteLength > MAX_CAPTURE_MANIFEST_BYTES) throw new RangeError('Capture manifest size changed while reading.');
  const manifest = parseManifest(uniqueKeyJson(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)));
  if (selected.size !== manifest.frames.length + 1) throw new TypeError('Selected frame files must exactly match the capture manifest, without extras.');
  const frameFiles = new Map<string, File>();
  for (const frame of manifest.frames) {
    const file = selected.get(frame.file);
    if (!file) throw new TypeError(`Missing selected frame file: ${frame.file}. Filenames are case sensitive.`);
    frameFiles.set(frame.file, file);
  }
  const bundle: CaptureBundle = Object.freeze({ manifest, manifestSha256: await digest(manifestBytes), files: new FileTable(frameFiles) });
  verified.set(bundle, new Set());
  manifestSnapshots.set(bundle, new Blob([manifestBytes], { type: 'application/json' }));
  return bundle;
}
/** Preserve the exact hashed UTF-8 bytes, including BOM and whitespace; never reserialize metadata. */
export function captureManifestFile(bundle: CaptureBundle): File {
  assertCaptureBundle(bundle);
  // Return a fresh handle so callers cannot alter methods on the private snapshot object.
  return new File([manifestSnapshots.get(bundle)!], 'capture.json', { type: 'application/json' });
}
function frameIndex(bundle: CaptureBundle, index: number): CaptureFrame {
  assertCaptureBundle(bundle);
  if (!Number.isSafeInteger(index) || index < 0 || index >= bundle.manifest.frames.length) throw new RangeError('Capture frame index is out of bounds.');
  return bundle.manifest.frames[index];
}
/** Hash the exact byte snapshot passed to preflight; do not reread a mutable external source. */
export async function loadCaptureFrame(bundle: CaptureBundle, index: number): Promise<Awaited<ReturnType<typeof preflightSplat>>> {
  const frame = frameIndex(bundle, index), file = bundle.files.get(frame.file)!;
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength !== file.size || bytes.byteLength > MAX_SPLAT_FILE_BYTES) throw new RangeError('Capture frame size changed while reading.');
  if (await digest(bytes) !== frame.sha256) throw new Error(`SHA-256 mismatch for ${frame.file}.`);
  const result = await preflightSplat(new File([bytes], frame.file));
  verified.get(bundle)!.add(index);
  return result;
}
/** Returns only verified metadata, never a guessed observation or renderer success claim. */
export function verifiedCaptureFrameSha256(bundle: CaptureBundle, index: number): string | null {
  const frame = frameIndex(bundle, index);
  return verified.get(bundle)!.has(index) ? frame.sha256 : null;
}

/** Piecewise-constant appearance: rightmost sample at or before clamped relative time. */
export function selectCaptureFrame(manifest: CaptureManifest, time: number): number {
  if (!finite(time)) throw new TypeError('Capture time must be finite.');
  if (!finite(manifest.duration) || manifest.duration <= 0 || !manifest.frames.length) throw new TypeError('Capture manifest has no valid timeline.');
  const clamped = Math.min(manifest.duration, Math.max(0, time));
  let low = 0, high = manifest.frames.length - 1;
  while (low < high) { const middle = Math.ceil((low + high) / 2); if (manifest.frames[middle].time <= clamped) low = middle; else high = middle - 1; }
  return low;
}
