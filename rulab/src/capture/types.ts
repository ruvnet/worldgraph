/** Time-indexed appearance, without an assertion of surveyed world registration. */
export interface CaptureFrame {
  readonly time: number;
  readonly file: string;
  readonly sha256: string;
}
export interface CaptureManifest {
  readonly format: 'worldgraph.rulab.capture';
  readonly version: 1;
  readonly name: string;
  readonly source: 'synthetic' | 'observed' | 'reconstructed';
  readonly coordinateSystem: 'right-handed-y-up';
  readonly units: 'metres';
  readonly duration: number;
  readonly bounds: { readonly min: readonly [number, number, number]; readonly max: readonly [number, number, number] };
  readonly frames: readonly CaptureFrame[];
}
export interface CaptureBundle {
  readonly manifest: CaptureManifest;
  readonly manifestSha256: string;
  /** Immutable File handles; no URLs, remote fetches, or archive extraction. */
  readonly files: ReadonlyMap<string, File>;
}
export interface CapturePlaybackState {
  readonly requestedTime: number;
  readonly displayedIndex: number | null;
  readonly displayedTime: number | null;
  readonly loading: boolean;
  readonly error: string | null;
}
