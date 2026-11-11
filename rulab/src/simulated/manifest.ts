import type {
  RolloutBundle, RolloutFileRef, RolloutGeneration, RolloutIndexEntry, RolloutManifest, RolloutMedia,
  SimulatedFrameDescriptor, SimulatedFrameEnvelope, SimulatedLicensePolicy, SimulatedModelProvenance,
  SimulatedPrivacyDecision, U64String, VerifiedRollout,
} from './types';

export const ROLLOUT_FORMAT = 'worldgraph.simulated.rollout';
export const ROLLOUT_INDEX_FORMAT = 'worldgraph.simulated.index';
export const ROLLOUT_MANIFEST_NAME = 'rollout.json';
export const MAX_ROLLOUT_MANIFEST_BYTES = 64 * 1024;
export const MAX_ROLLOUT_MEDIA_BYTES = 64 * 1024 * 1024;
export const MAX_ROLLOUT_CAPTION_BYTES = 64 * 1024;
export const MAX_ROLLOUT_FIRST_FRAME_BYTES = 8 * 1024 * 1024;
export const MAX_ROLLOUT_DURATION_SEC = 20;
export const MAX_ROLLOUT_INDEX_ENTRIES = 16;
/** Rust `MAX_FRAME_DESCRIPTORS`; the 64 KiB manifest limit binds first in practice. */
const MAX_ENVELOPE_FRAMES = 1024;
const MAX_ENVELOPE_STRING = 4096;
const MAX_U64 = (1n << 64n) - 1n;

/** Returns the complete bytes of one flat file of the rollout, or rejects if it exceeds `maxBytes`. */
export type RolloutReader = (file: string, maxBytes: number) => Promise<ArrayBuffer>;

// Only validated bundles enter these registries; only hash-verified byte snapshots enter `verified`.
const readers = new WeakMap<RolloutBundle, RolloutReader>();
const verified = new WeakMap<RolloutBundle, VerifiedRollout>();

export function assertRolloutBundle(value: unknown): asserts value is RolloutBundle {
  if (!value || typeof value !== 'object' || !readers.has(value as RolloutBundle)) throw new TypeError('Load and validate rollout files before using this rollout.');
}
/** Verified byte snapshots, or null while the rollout's files have not passed SHA-256 verification. */
export function verifiedRollout(bundle: RolloutBundle): VerifiedRollout | null {
  assertRolloutBundle(bundle);
  return verified.get(bundle) ?? null;
}

type Fields = Record<string, unknown>;
function plain(value: unknown, label: string): Fields {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError(`${label} must be a JSON object.`);
  return value as Fields;
}
/** Closed object: every key must be listed, and every required key present. */
function closed(value: unknown, label: string, required: readonly string[], optional: readonly string[] = []): Fields {
  const fields = plain(value, label);
  for (const key of Object.keys(fields)) if (!required.includes(key) && !optional.includes(key)) throw new TypeError(`${label} has an unsupported field: ${JSON.stringify(key)}.`);
  for (const key of required) if (!Object.hasOwn(fields, key)) throw new TypeError(`${label} is missing the required field ${JSON.stringify(key)}.`);
  return fields;
}
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const hasControl = (value: string) => /[\x00-\x1f\x7f]/.test(value);
/** Envelope and measurement strings follow the Rust writer, which bounds none of them: only type and a size cap are checked. They are only ever rendered as text. */
function text(value: unknown, label: string, max = MAX_ENVELOPE_STRING): string {
  if (typeof value !== 'string' || value.length > max) throw new TypeError(`${label} must be a string of at most ${max} characters.`);
  return value;
}
function flag(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be true or false.`);
  return value;
}
/** Rust u64. Values above 2^53 arrive as BigInt from `strictJson` and are kept as exact decimal digits. */
function u64(value: unknown, label: string): U64String {
  if (typeof value === 'bigint' && value >= 0n && value <= MAX_U64) return value.toString();
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) throw new RangeError(`${label} is too large for this browser to read exactly; it cannot be shown without rounding.`);
  throw new TypeError(`${label} must be an unsigned 64-bit integer.`);
}
function integerIn(value: unknown, low: number, high: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < low || (value as number) > high) throw new RangeError(`${label} must be an integer from ${low} to ${high}.`);
  return value as number;
}

/**
 * Parse JSON, rejecting duplicate object keys (including escaped aliases) and preserving
 * integers beyond 2^53 as BigInt where the engine exposes number source text.
 */
function strictJson(source: string, label: string): unknown {
  let parsed: unknown;
  const reviver = (_key: string, value: unknown, context?: { source?: string }) =>
    typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value) && typeof context?.source === 'string' && /^(?:0|[1-9]\d*)$/.test(context.source)
      ? BigInt(context.source) : value;
  try { parsed = JSON.parse(source, reviver as (key: string, value: unknown) => unknown); }
  catch { throw new SyntaxError(`${label} is not valid JSON.`); }
  const objects: Array<Set<string> | null> = [];
  for (let i = 0; i < source.length; i++) {
    const character = source[i];
    if (character === '{') objects.push(new Set());
    else if (character === '[') objects.push(null);
    else if (character === '}' || character === ']') objects.pop();
    else if (character === '"') {
      const start = i++;
      while (source[i] !== '"') { if (source[i] === '\\') i++; i++; }
      let next = i + 1;
      while (next < source.length && /\s/.test(source[next])) next++;
      if (source[next] !== ':') continue;
      const key = JSON.parse(source.slice(start, i + 1)) as string, keys = objects.at(-1)!;
      if (keys.has(key)) throw new TypeError(`${label} contains a duplicate object field: ${JSON.stringify(key)}.`);
      keys.add(key);
    }
  }
  return parsed;
}

/** Same flat ASCII rule as capture frame names: no paths, no leading dot, at most 128 characters. */
function flatFile(value: unknown, label: string, extensions: readonly string[]): string {
  if (typeof value !== 'string' || value.length > 128 || !/^[a-z0-9][a-z0-9_-]*(?:\.[a-z0-9_-]+)*$/i.test(value)) throw new TypeError(`${label} must be a flat ASCII filename of at most 128 characters, without a path.`);
  if (!extensions.some(extension => value.toLowerCase().endsWith(extension))) throw new TypeError(`${label} must end with ${extensions.join(', ')}.`);
  return value;
}
function sha256Hex(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new TypeError(`${label} must contain 64 lowercase hexadecimal characters.`);
  return value;
}
function byteCount(value: unknown, label: string, limit: number, limitName: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new RangeError(`${label} must be a positive safe integer.`);
  if ((value as number) > limit) throw new RangeError(`${label} exceeds the ${limitName} limit.`);
  return value as number;
}
function fileRef(fields: Fields, label: string, extensions: readonly string[], limit: number, limitName: string): RolloutFileRef {
  return { file: flatFile(fields.file, `${label}.file`, extensions), sha256: sha256Hex(fields.sha256, `${label}.sha256`), bytes: byteCount(fields.bytes, `${label}.bytes`, limit, limitName) };
}

function parseMedia(value: unknown): RolloutMedia {
  const fields = closed(value, 'media', ['file', 'sha256', 'bytes', 'mediaType', 'width', 'height', 'fps', 'durationSec']);
  const ref = fileRef(fields, 'media', ['.mp4'], MAX_ROLLOUT_MEDIA_BYTES, '64 MiB');
  if (fields.mediaType !== 'video/mp4') throw new TypeError('media.mediaType must be exactly "video/mp4".');
  const width = integerIn(fields.width, 16, 4096, 'media.width'), height = integerIn(fields.height, 16, 4096, 'media.height');
  if (!finite(fields.fps) || fields.fps < 1 || fields.fps > 120) throw new RangeError('media.fps must be from 1 to 120.');
  if (!finite(fields.durationSec) || fields.durationSec <= 0 || fields.durationSec > MAX_ROLLOUT_DURATION_SEC) throw new RangeError('media.durationSec must be greater than zero and at most 20 seconds.');
  return Object.freeze({ ...ref, mediaType: 'video/mp4', width, height, fps: fields.fps, durationSec: fields.durationSec });
}

function parseGeneration(value: unknown): RolloutGeneration {
  const fields = closed(value, 'generation', [], ['hardware', 'steps', 'seconds', 'peakVramGb']);
  const generation: { hardware?: string; steps?: number; seconds?: number; peakVramGb?: number } = {};
  if (Object.hasOwn(fields, 'hardware')) generation.hardware = text(fields.hardware, 'generation.hardware', 512);
  if (Object.hasOwn(fields, 'steps')) generation.steps = integerIn(fields.steps, 0, 0xffff_ffff, 'generation.steps');
  for (const key of ['seconds', 'peakVramGb'] as const) {
    if (!Object.hasOwn(fields, key)) continue;
    const measured = fields[key];
    if (!finite(measured) || measured < 0) throw new RangeError(`generation.${key} must be a finite, non-negative measurement.`);
    generation[key] = measured;
  }
  return Object.freeze(generation);
}

/**
 * The envelope is the serde form of Rust `SimulatedFrameEnvelope`. Fields this viewer uses are
 * type-checked; additional fields are tolerated and dropped so the Rust type can grow.
 */
function parseEnvelope(value: unknown): SimulatedFrameEnvelope {
  const root = plain(value, 'envelope');
  if (root.schema_version !== 1) throw new TypeError('envelope.schema_version must be 1.');
  const chunk = plain(root.chunk, 'envelope.chunk');
  if (!Array.isArray(chunk.frames) || chunk.frames.length < 1 || chunk.frames.length > MAX_ENVELOPE_FRAMES) throw new RangeError(`envelope.chunk.frames must list 1–${MAX_ENVELOPE_FRAMES} frame descriptors.`);
  const frames = chunk.frames.map((item, index): SimulatedFrameDescriptor => {
    const label = `envelope.chunk.frames[${index}]`, frame = plain(item, label);
    return Object.freeze({ transport: text(frame.transport, `${label}.transport`), locator: text(frame.locator, `${label}.locator`),
      content_hash: text(frame.content_hash, `${label}.content_hash`), byte_length: u64(frame.byte_length, `${label}.byte_length`),
      media_type: text(frame.media_type, `${label}.media_type`) });
  });
  const label = 'envelope.chunk.provenance', source = plain(chunk.provenance, label);
  if (source.simulated !== true) throw new TypeError('envelope.chunk.provenance.simulated must be literally true.');
  if (!finite(source.confidence) || source.confidence < 0 || source.confidence > 1) throw new RangeError(`${label}.confidence must be from 0 to 1.`);
  const privacyFields = plain(source.privacy, `${label}.privacy`), licenseFields = plain(source.license, `${label}.license`);
  if (privacyFields.retention !== 'ephemeral' && privacyFields.retention !== 'policy_bound') throw new TypeError(`${label}.privacy.retention must be "ephemeral" or "policy_bound".`);
  if (licenseFields.usage !== 'production' && licenseFields.usage !== 'research_only') throw new TypeError(`${label}.license.usage must be "production" or "research_only".`);
  const privacy: SimulatedPrivacyDecision = Object.freeze({ projection_id: text(privacyFields.projection_id, `${label}.privacy.projection_id`),
    hosted_processing_approved: flag(privacyFields.hosted_processing_approved, `${label}.privacy.hosted_processing_approved`),
    redactions_applied: integerIn(privacyFields.redactions_applied, 0, 0xffff_ffff, `${label}.privacy.redactions_applied`), retention: privacyFields.retention });
  const license: SimulatedLicensePolicy = Object.freeze({ license_id: text(licenseFields.license_id, `${label}.license.license_id`), usage: licenseFields.usage,
    redistribution_allowed: flag(licenseFields.redistribution_allowed, `${label}.license.redistribution_allowed`),
    attribution_required: flag(licenseFields.attribution_required, `${label}.license.attribution_required`),
    notice: licenseFields.notice === null || licenseFields.notice === undefined ? null : text(licenseFields.notice, `${label}.license.notice`) });
  const provenance: SimulatedModelProvenance = Object.freeze({
    provider: text(source.provider, `${label}.provider`), model: text(source.model, `${label}.model`), checkpoint: text(source.checkpoint, `${label}.checkpoint`),
    runtime_version: text(source.runtime_version, `${label}.runtime_version`), source_snapshot_hash: text(source.source_snapshot_hash, `${label}.source_snapshot_hash`),
    source_stream_epoch: u64(source.source_stream_epoch, `${label}.source_stream_epoch`), prompt_action_hash: text(source.prompt_action_hash, `${label}.prompt_action_hash`),
    generation_seed: u64(source.generation_seed, `${label}.generation_seed`), generation_sequence: u64(source.generation_sequence, `${label}.generation_sequence`),
    simulated: true, confidence: source.confidence, privacy, license });
  return Object.freeze({ schema_version: 1, session_id: text(root.session_id, 'envelope.session_id'), epoch: u64(root.epoch, 'envelope.epoch'),
    sequence: u64(root.sequence, 'envelope.sequence'), chunk: Object.freeze({ frames: Object.freeze(frames), provenance }) });
}

/** Validate a parsed `rollout.json` value. Returns a deeply frozen manifest containing only known fields. */
export function parseRolloutManifest(value: unknown): RolloutManifest {
  const root = closed(value, 'Rollout manifest', ['format', 'version', 'name', 'simulated', 'media', 'caption', 'envelope'], ['firstFrame', 'generation']);
  if (root.format !== ROLLOUT_FORMAT) throw new TypeError(`Rollout format must be exactly "${ROLLOUT_FORMAT}". A capture manifest is not a rollout.`);
  if (root.version !== 1) throw new TypeError('Unsupported rollout version; only version 1 is accepted.');
  if (root.simulated !== true) throw new TypeError('Rollout "simulated" must be literally true.');
  // Counted in code points, as the Rust writer counts `chars()`.
  if (typeof root.name !== 'string' || !root.name.length || [...root.name].length > 120 || root.name !== root.name.trim() || hasControl(root.name)) throw new TypeError('Rollout name must contain 1–120 trimmed characters without control characters.');
  const media = parseMedia(root.media);
  const caption = Object.freeze(fileRef(closed(root.caption, 'caption', ['file', 'sha256', 'bytes']), 'caption', ['.json'], MAX_ROLLOUT_CAPTION_BYTES, '64 KiB'));
  const firstFrame = Object.hasOwn(root, 'firstFrame')
    ? Object.freeze(fileRef(closed(root.firstFrame, 'firstFrame', ['file', 'sha256', 'bytes']), 'firstFrame', ['.png', '.jpg', '.jpeg'], MAX_ROLLOUT_FIRST_FRAME_BYTES, '8 MiB')) : undefined;
  const names = [ROLLOUT_MANIFEST_NAME, media.file, caption.file, ...(firstFrame ? [firstFrame.file] : [])].map(name => name.toLowerCase());
  if (new Set(names).size !== names.length) throw new TypeError('Rollout filenames must be distinct ignoring case and must not reuse rollout.json.');
  const envelope = parseEnvelope(root.envelope);
  const video = envelope.chunk.frames.find(frame => frame.media_type === 'video/mp4');
  if (!video) throw new TypeError('envelope.chunk.frames has no video/mp4 frame descriptor for the rollout media.');
  if (video.content_hash !== `sha256:${media.sha256}`) throw new TypeError('The envelope video/mp4 content_hash does not equal "sha256:" + media.sha256.');
  if (video.byte_length !== String(media.bytes)) throw new TypeError('The envelope video/mp4 byte_length does not equal media.bytes.');
  const generation = Object.hasOwn(root, 'generation') ? parseGeneration(root.generation) : undefined;
  return Object.freeze({ format: ROLLOUT_FORMAT, version: 1, name: root.name, simulated: true, media, caption,
    ...(firstFrame ? { firstFrame } : {}), envelope, ...(generation ? { generation } : {}) });
}

/** Validate a parsed bundled index. Adding a rollout is one entry here; no code changes. */
export function parseRolloutIndex(value: unknown): readonly RolloutIndexEntry[] {
  const root = closed(value, 'Rollout index', ['format', 'version', 'rollouts']);
  if (root.format !== ROLLOUT_INDEX_FORMAT || root.version !== 1) throw new TypeError(`Rollout index must have format "${ROLLOUT_INDEX_FORMAT}" and version 1.`);
  if (!Array.isArray(root.rollouts) || root.rollouts.length > MAX_ROLLOUT_INDEX_ENTRIES) throw new RangeError(`Rollout index lists at most ${MAX_ROLLOUT_INDEX_ENTRIES} rollouts.`);
  const seen = new Set<string>();
  return Object.freeze(root.rollouts.map((item, index): RolloutIndexEntry => {
    const entry = closed(item, `Rollout index entry ${index}`, ['id', 'path']);
    if (typeof entry.id !== 'string' || !/^[a-z0-9-]{1,48}$/.test(entry.id)) throw new TypeError(`Rollout index entry ${index} id must be 1–48 lowercase letters, digits or hyphens.`);
    if (entry.path !== `${entry.id}/${ROLLOUT_MANIFEST_NAME}`) throw new TypeError(`Rollout index entry "${entry.id}" path must be exactly "${entry.id}/${ROLLOUT_MANIFEST_NAME}".`);
    if (seen.has(entry.id)) throw new TypeError(`Rollout index lists "${entry.id}" more than once.`);
    seen.add(entry.id);
    return Object.freeze({ id: entry.id, path: entry.path });
  }));
}
export function parseRolloutIndexText(source: string): readonly RolloutIndexEntry[] {
  return parseRolloutIndex(strictJson(source, 'Rollout index'));
}

async function digest(bytes: ArrayBuffer): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('SHA-256 verification requires a secure browser context.');
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('');
}
function decodeUtf8(bytes: ArrayBuffer, label: string): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new TypeError(`${label} is not valid UTF-8.`); }
}

/** Read and validate `rollout.json` through `read`. No media is fetched, hashed or trusted yet. */
export async function openRollout(read: RolloutReader, origin: RolloutBundle['origin']): Promise<RolloutBundle> {
  const bytes = await read(ROLLOUT_MANIFEST_NAME, MAX_ROLLOUT_MANIFEST_BYTES);
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_ROLLOUT_MANIFEST_BYTES) throw new RangeError('rollout.json must be between 1 byte and 64 KiB.');
  const manifest = parseRolloutManifest(strictJson(decodeUtf8(bytes, 'rollout.json'), 'rollout.json'));
  const bundle: RolloutBundle = Object.freeze({ manifest, manifestSha256: await digest(bytes), origin });
  readers.set(bundle, read);
  return bundle;
}

/** One local multi-file selection: rollout.json plus exactly the files it names. Nothing is uploaded. */
export async function loadRolloutFiles(files: readonly File[]): Promise<RolloutBundle> {
  if (!Array.isArray(files) || files.length < 3 || files.length > 4) throw new RangeError('Select rollout.json together with its video, caption and optional first-frame image.');
  const selected = new Map<string, File>(), folded = new Set<string>();
  for (const file of files) {
    if (!(file instanceof File)) throw new TypeError('Rollouts require local File handles.');
    if (folded.has(file.name.toLowerCase())) throw new TypeError('Duplicate selected filename, ignoring case.');
    folded.add(file.name.toLowerCase()); selected.set(file.name, file);
  }
  const manifestFile = selected.get(ROLLOUT_MANIFEST_NAME);
  if (!manifestFile) throw new TypeError('Select the manifest named exactly rollout.json.');
  if (manifestFile.size < 1 || manifestFile.size > MAX_ROLLOUT_MANIFEST_BYTES) throw new RangeError('rollout.json must be between 1 byte and 64 KiB.');
  const read: RolloutReader = async (name, maxBytes) => {
    const file = selected.get(name);
    if (!file) throw new TypeError(`Missing selected rollout file: ${name}. Filenames are case sensitive.`);
    if (file.size > maxBytes) throw new RangeError(`${name} exceeds its ${maxBytes} byte limit.`);
    const bytes = await file.arrayBuffer();
    if (bytes.byteLength !== file.size) throw new RangeError(`${name} changed size while reading.`);
    return bytes;
  };
  const bundle = await openRollout(read, 'local');
  const { media, caption, firstFrame } = bundle.manifest, named = [media, caption, ...(firstFrame ? [firstFrame] : [])];
  if (selected.size !== named.length + 1) throw new TypeError('Selected files must exactly match the rollout manifest, without extras.');
  for (const ref of named) {
    const file = selected.get(ref.file);
    if (!file) throw new TypeError(`Missing selected rollout file: ${ref.file}. Filenames are case sensitive.`);
    if (file.size !== ref.bytes) throw new RangeError(`Byte length mismatch for ${ref.file}: the manifest declares ${ref.bytes}, the selected file has ${file.size}.`);
  }
  return bundle;
}

async function readVerified(read: RolloutReader, ref: RolloutFileRef, limit: number): Promise<ArrayBuffer> {
  const bytes = await read(ref.file, limit);
  if (bytes.byteLength !== ref.bytes) throw new RangeError(`Byte length mismatch for ${ref.file}: the manifest declares ${ref.bytes}, received ${bytes.byteLength}.`);
  if (await digest(bytes) !== ref.sha256) throw new Error(`SHA-256 mismatch for ${ref.file}. The rollout will not be played.`);
  return bytes;
}

/**
 * Hash every file the manifest names. The returned Blobs wrap the exact byte snapshots that
 * passed, so the player never rereads a mutable source. Any mismatch rejects the whole rollout.
 * Matching hashes authenticate bytes against this manifest only, not the manifest's origin.
 */
export async function verifyRollout(bundle: RolloutBundle): Promise<VerifiedRollout> {
  assertRolloutBundle(bundle);
  const existing = verified.get(bundle);
  if (existing) return existing;
  const read = readers.get(bundle)!, { media, caption, firstFrame } = bundle.manifest;
  const mediaBytes = await readVerified(read, media, MAX_ROLLOUT_MEDIA_BYTES);
  const captionText = decodeUtf8(await readVerified(read, caption, MAX_ROLLOUT_CAPTION_BYTES), caption.file);
  const firstFrameBytes = firstFrame ? await readVerified(read, firstFrame, MAX_ROLLOUT_FIRST_FRAME_BYTES) : null;
  const result: VerifiedRollout = Object.freeze({ bundle, media: new Blob([mediaBytes], { type: 'video/mp4' }), mediaSha256: media.sha256,
    captionText, captionSha256: caption.sha256,
    firstFrame: firstFrame && firstFrameBytes ? new Blob([firstFrameBytes], { type: firstFrame.file.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg' }) : null,
    firstFrameSha256: firstFrame?.sha256 ?? null });
  verified.set(bundle, result);
  return result;
}
