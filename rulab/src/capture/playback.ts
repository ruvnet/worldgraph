import type { CapturePlaybackState } from './types';

export interface PlaybackOptions<T> {
  readonly frames: readonly { readonly time: number }[];
  readonly duration: number;
  readonly select: (time: number) => number;
  readonly decode: (index: number, signal: AbortSignal) => Promise<T>;
  /** Synchronous commit. The previous asset is disposed only after this succeeds. */
  readonly display: (asset: T, index: number) => void;
  readonly disposeAsset: (asset: T) => void;
  readonly onState?: (state: CapturePlaybackState) => void;
}

/** Bounded sample-and-hold playback. No timer or fabricated interpolation. */
export class CapturePlayback<T> {
  private wantedIndex = 0;
  private requestedTime = 0;
  private current: { asset: T; index: number } | null = null;
  private inFlight: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private failure: { index: number; message: string } | null = null;
  private disposed = false;
  private suspended = false;
  private epoch = 0;

  constructor(private readonly options: PlaybackOptions<T>) {
    if (!options.frames.length || !Number.isFinite(options.duration) || options.duration <= 0) throw new Error('Invalid capture playback configuration.');
  }

  get displayedAsset(): T | null { return this.current?.asset ?? null; }

  getState(): CapturePlaybackState {
    return Object.freeze({ requestedTime: this.requestedTime, displayedIndex: this.current?.index ?? null,
      displayedTime: this.current ? this.options.frames[this.current.index]!.time : null,
      loading: !this.disposed && !this.suspended && this.current?.index !== this.wantedIndex && this.failure?.index !== this.wantedIndex,
      error: this.failure?.index === this.wantedIndex ? this.failure.message : null });
  }

  seek(time: number): void {
    if (this.disposed) return;
    if (!Number.isFinite(time)) throw new Error('Capture time must be finite.');
    this.requestedTime = Math.min(this.options.duration, Math.max(0, time));
    const index = this.options.select(this.requestedTime);
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.options.frames.length) throw new Error('Invalid capture sample index.');
    if (index !== this.wantedIndex) this.failure = null;
    this.wantedIndex = index;
    this.emit();
    this.pump();
  }

  /** Retry is explicit; a playback clock cannot create a failed-decode loop. */
  retry(): void {
    if (this.disposed) return;
    this.failure = null;
    this.emit();
    this.pump();
  }

  /** Stop accepting a pending result while holding the displayed asset. */
  suspend(): void {
    if (this.disposed) return;
    this.suspended = true;
    this.epoch++;
    this.abort?.abort();
    this.emit();
  }

  resume(): void {
    if (this.disposed) return;
    this.suspended = false;
    this.emit();
    this.pump();
  }

  /** For initial transactional loading and deterministic tests. */
  async settled(): Promise<CapturePlaybackState> {
    while (this.inFlight) await this.inFlight;
    return this.getState();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.epoch++;
    this.abort?.abort();
    if (this.current) this.options.disposeAsset(this.current.asset);
    this.current = null;
  }

  private emit(): void { if (!this.disposed) this.options.onState?.(this.getState()); }

  private pump(): void {
    if (this.disposed || this.suspended || this.inFlight || this.current?.index === this.wantedIndex || this.failure?.index === this.wantedIndex) return;
    const index = this.wantedIndex;
    const epoch = this.epoch;
    const abort = new AbortController();
    this.abort = abort;
    // Begin on a microtask so the inFlight slot is set even for synchronous errors.
    this.inFlight = Promise.resolve().then(async () => {
      let candidate: T | undefined;
      try {
        candidate = await this.options.decode(index, abort.signal);
        if (this.disposed || this.suspended || abort.signal.aborted || epoch !== this.epoch || index !== this.wantedIndex) {
          this.options.disposeAsset(candidate); candidate = undefined; return;
        }
        this.options.display(candidate, index);
        const previous = this.current;
        this.current = { asset: candidate, index };
        candidate = undefined;
        this.failure = null;
        if (previous) this.options.disposeAsset(previous.asset);
      } catch (error) {
        if (candidate !== undefined) this.options.disposeAsset(candidate);
        if (!this.disposed && !this.suspended && !abort.signal.aborted && epoch === this.epoch && index === this.wantedIndex) {
          this.failure = { index, message: (error instanceof Error ? error.message : 'Capture frame failed to decode.').slice(0,240) };
        }
      } finally {
        this.inFlight = null;
        if (this.abort === abort) this.abort = null;
        this.emit();
        this.pump();
      }
    });
  }
}

/** One fixed preview transform for every sample, never per-frame recentering. */
export function capturePreviewTransform(bounds: {readonly min:readonly [number,number,number];readonly max:readonly [number,number,number]}):{scale:number;position:[number,number,number]} {
  const extents=bounds.max.map((value,index)=>value-bounds.min[index]!);
  if(![...bounds.min,...bounds.max,...extents].every(Number.isFinite)||extents.some(value=>value<=0))throw new Error('Capture bounds must have finite positive extents.');
  const longest=Math.max(...extents);
  if(longest<.01)throw new Error('Capture bounds must span at least one centimetre for browser preview.');
  const scale=18/longest;
  const center=bounds.min.map((value,index)=>value+extents[index]!/2);
  const position:[number,number,number]=[-center[0]!*scale,-bounds.min[1]*scale,-center[2]!*scale];
  if(!Number.isFinite(scale)||scale<=0||!position.every(Number.isFinite))throw new Error('Capture preview transform is not finite.');
  return {scale,position};
}
