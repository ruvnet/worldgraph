import type { CaptureBundle, CapturePlaybackState } from './capture/types';
/** RuLab scene contract. Positions are metres in East, North, Up. */
export type Vec3 = [number, number, number];
export type ScenarioId = 'robotics' | 'hospitality' | 'healthcare';
export type ViewMode = 'cinematic' | 'splats' | 'graph';
export type Quality = 'auto' | 'performance' | 'quality';
export type SourceKind = 'authored' | 'observed' | 'predicted';
export interface EntityState {
  id: string; kind: 'robot' | 'amr' | 'drone' | 'door' | 'sensor'; label: string;
  position: Vec3; yaw: number; joints: number[]; source: SourceKind; confidence: number;
}
export interface TimelineEvent {
  id: string; time: number; sequence: number;
  kind: 'door' | 'pause-agent'; entityId: string; value: boolean;
}
export interface WorldFrame {
  version: 1; time: number; scenario: ScenarioId; revision: number;
  entities: EntityState[]; events: TimelineEvent[];
}
export interface RenderMetrics {
  backend: 'webgl2' | 'unavailable'; fps: number; frameMs: number;
  splatCount: number; drawCalls: number; camera: Vec3; status: string;
  frameTimesMs?: number[];
}
export interface RuLabView {
  setFrame(frame: WorldFrame): void;
  setMode(mode: ViewMode): void;
  setQuality(quality: Quality): void;
  cameraPreset(name: 'overview' | 'robot' | 'drone' | 'rf'): void;
  move(forward: number, right: number): void;
  reset(): void;
  loadSplat(file: File): Promise<void>;
  loadCapture(bundle: CaptureBundle): Promise<CapturePlaybackState>;
  seekCapture(time: number): void;
  retryCapture(): void;
  dispose(): void;
}
export interface ViewOptions {
  canvas: HTMLCanvasElement;
  onSelect: (id: string) => void;
  onMetrics: (metrics: RenderMetrics) => void;
  onCaptureState?: (state: CapturePlaybackState, bundle: CaptureBundle) => void;
}
