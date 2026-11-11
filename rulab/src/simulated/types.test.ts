import { describe, expect, it } from 'vitest';
import { parseRolloutManifest } from './manifest';
import type { RolloutManifest, RolloutPlaybackState } from './types';

/** A literal that must type-check against `types.ts`; `npm run typecheck` fails if the types drift from it. */
const typed = {
  format: 'worldgraph.simulated.rollout', version: 1, name: 'RF door opens', simulated: true,
  media: { file: 'clip.mp4', sha256: 'a'.repeat(64), bytes: 1234567, mediaType: 'video/mp4', width: 1248, height: 704, fps: 24, durationSec: 5 },
  caption: { file: 'caption.json', sha256: 'b'.repeat(64), bytes: 4321 },
  firstFrame: { file: 'first.png', sha256: 'c'.repeat(64), bytes: 99999 },
  envelope: { schema_version: 1, session_id: 'pan2-1', epoch: '0', sequence: '2', chunk: {
    frames: [{ transport: 'file', locator: 'media/pan2-1/clip.mp4', content_hash: `sha256:${'a'.repeat(64)}`, byte_length: '1234567', media_type: 'video/mp4' }],
    provenance: { provider: 'pan2', model: 'PAN-2', checkpoint: 'ckpt', runtime_version: '0.1.0', source_snapshot_hash: 'sha256:s', source_stream_epoch: '7',
      prompt_action_hash: 'sha256:p', generation_seed: '18446744073709551615', generation_sequence: '2', simulated: true, confidence: 0.5,
      privacy: { projection_id: 'p', hosted_processing_approved: true, redactions_applied: 0, retention: 'policy_bound' },
      license: { license_id: 'Apache-2.0', usage: 'research_only', redistribution_allowed: false, attribution_required: true, notice: 'Retain NOTICE.' } } } },
  generation: { hardware: '1x H200 NVL 140GB', steps: 50, seconds: 412.5, peakVramGb: 96.2 },
} as const satisfies RolloutManifest;

describe('simulated rollout types', () => {
  it('describe exactly what the validator returns: camelCase manifest, snake_case envelope, u64 as decimal strings', () => {
    // The wire form carries u64 fields as JSON numbers; the typed form carries them as exact strings.
    const U64_KEYS = ['epoch', 'sequence', 'byte_length', 'source_stream_epoch', 'generation_seed', 'generation_sequence'];
    const wire = JSON.parse(JSON.stringify(typed), (key, value) => U64_KEYS.includes(key) && key !== 'generation_seed' ? Number(value) : value);
    wire.envelope.chunk.provenance.generation_seed = 18446744073709551615n;
    const parsed = parseRolloutManifest(wire);
    expect(parsed).toEqual(typed);
    expect(Object.keys(parsed)).toEqual(Object.keys(typed));
    expect(Object.keys(parsed.envelope.chunk.provenance)).toEqual(Object.keys(typed.envelope.chunk.provenance));
    expect(parsed).not.toHaveProperty('source'); expect(parsed).not.toHaveProperty('frames'); expect(parsed).not.toHaveProperty('duration');
  });

  it('has no observed or reconstructed vocabulary in a playback state', () => {
    const phases: Array<RolloutPlaybackState['phase']> = ['ready', 'playing', 'paused', 'ended', 'error'];
    expect(phases.some(phase => /observ|reconstruct|captur/.test(phase))).toBe(false);
  });
});
