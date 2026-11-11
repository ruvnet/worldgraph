/**
 * Simulated rollout: a short video predicted by a generative world model (ADR-204).
 * A rollout is never a capture. It carries no observed or reconstructed claim and
 * shares no type, manifest format, player or graph id with `../capture`.
 */

/** Unsigned 64-bit Rust integers are kept as exact decimal strings; a JS number would round above 2^53. */
export type U64String = string;

export interface RolloutFileRef {
  readonly file: string;
  /** 64 lowercase hexadecimal characters over the complete file bytes. */
  readonly sha256: string;
  readonly bytes: number;
}
export interface RolloutMedia extends RolloutFileRef {
  readonly mediaType: 'video/mp4';
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly durationSec: number;
}
/** Optional measured generation statistics. Absent fields were not measured. */
export interface RolloutGeneration {
  readonly hardware?: string;
  readonly steps?: number;
  readonly seconds?: number;
  readonly peakVramGb?: number;
}

/** JSON form of Rust `FrameDescriptor` (wifi-densepose-worldmodel/src/runtime.rs); snake_case is intentional. */
export interface SimulatedFrameDescriptor {
  readonly transport: string;
  readonly locator: string;
  readonly content_hash: string;
  readonly byte_length: U64String;
  readonly media_type: string;
}
export interface SimulatedPrivacyDecision {
  readonly projection_id: string;
  readonly hosted_processing_approved: boolean;
  readonly redactions_applied: number;
  readonly retention: 'ephemeral' | 'policy_bound';
}
export interface SimulatedLicensePolicy {
  readonly license_id: string;
  readonly usage: 'production' | 'research_only';
  readonly redistribution_allowed: boolean;
  readonly attribution_required: boolean;
  readonly notice: string | null;
}
export interface SimulatedModelProvenance {
  readonly provider: string;
  readonly model: string;
  readonly checkpoint: string;
  readonly runtime_version: string;
  readonly source_snapshot_hash: string;
  readonly source_stream_epoch: U64String;
  readonly prompt_action_hash: string;
  readonly generation_seed: U64String;
  readonly generation_sequence: U64String;
  readonly simulated: true;
  /** Provider-reported value in [0, 1]. Not an accuracy assessment made by this viewer. */
  readonly confidence: number;
  readonly privacy: SimulatedPrivacyDecision;
  readonly license: SimulatedLicensePolicy;
}
/** JSON form of Rust `SimulatedFrameEnvelope`. */
export interface SimulatedFrameEnvelope {
  readonly schema_version: 1;
  readonly session_id: string;
  readonly epoch: U64String;
  readonly sequence: U64String;
  readonly chunk: {
    readonly frames: readonly SimulatedFrameDescriptor[];
    readonly provenance: SimulatedModelProvenance;
  };
}

export interface RolloutManifest {
  readonly format: 'worldgraph.simulated.rollout';
  readonly version: 1;
  readonly name: string;
  readonly simulated: true;
  readonly media: RolloutMedia;
  /** The structured prompt sent to the model. */
  readonly caption: RolloutFileRef;
  /** Optional conditioning image. */
  readonly firstFrame?: RolloutFileRef;
  readonly envelope: SimulatedFrameEnvelope;
  readonly generation?: RolloutGeneration;
}

/** A validated manifest. Its files are not verified until `verifyRollout` succeeds. */
export interface RolloutBundle {
  readonly manifest: RolloutManifest;
  /** SHA-256 of the exact `rollout.json` bytes. */
  readonly manifestSha256: string;
  readonly origin: 'bundled' | 'local';
}
/** Byte snapshots that matched the manifest's declared length and SHA-256. */
export interface VerifiedRollout {
  readonly bundle: RolloutBundle;
  readonly media: Blob;
  readonly mediaSha256: string;
  readonly captionText: string;
  readonly captionSha256: string;
  readonly firstFrame: Blob | null;
  readonly firstFrameSha256: string | null;
}

export interface RolloutIndexEntry {
  readonly id: string;
  readonly path: string;
}

export type RolloutPhase = 'ready' | 'playing' | 'paused' | 'ended' | 'error';
export interface RolloutPlaybackState {
  readonly phase: RolloutPhase;
  /** Position inside the predicted clip, in clip-relative seconds. Not world time. */
  readonly positionSec: number;
  readonly error: string | null;
}
