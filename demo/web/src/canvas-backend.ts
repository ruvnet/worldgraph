import type { AssetFormat, RenderPrimitive, Rgba, Vec3 } from '../../../supersplat-bridge/src/types.js';
import type { EntityHandle, SceneBackend } from '../../../supersplat-bridge/src/renderer.js';

interface CanvasEntity { primitive: RenderPrimitive }

export class CanvasSceneBackend implements SceneBackend {
  private readonly entities = new Set<CanvasEntity>();
  private readonly lines: Array<{ from: Vec3; to: Vec3; color: Rgba }> = [];
  private readonly context: CanvasRenderingContext2D;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas2D is unavailable');
    this.context = context;
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
  }

  create(primitive: RenderPrimitive): EntityHandle {
    const entity = { primitive };
    this.entities.add(entity);
    return entity;
  }
  async loadAsset(_url: string, _format: AssetFormat, _integrity: string | undefined, _signal: AbortSignal): Promise<EntityHandle> {
    throw new Error('the top-down demo does not instantiate 3D assets');
  }
  update(handle: EntityHandle, primitive: RenderPrimitive): void { (handle as CanvasEntity).primitive = primitive; }
  destroy(handle: EntityHandle): void { this.entities.delete(handle as CanvasEntity); }
  drawLine(from: Vec3, to: Vec3, color: Rgba): void { this.lines.push({ from, to, color }); }
  beginFrame(): void { this.lines.length = 0; }

  render(): void {
    const { width, height } = this.canvas;
    const ctx = this.context;
    ctx.clearRect(0, 0, width, height);
    this.grid();
    for (const entity of this.entities) this.drawPrimitive(entity.primitive);
    for (const line of this.lines) {
      const a = this.point(line.from); const b = this.point(line.to);
      ctx.strokeStyle = css(line.color); ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    }
  }

  private resize(): void {
    const ratio = Math.min(devicePixelRatio, 2);
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(rect.width * ratio));
    this.canvas.height = Math.max(1, Math.round(rect.height * ratio));
    this.render();
  }

  private point([x, _y, z]: Vec3): [number, number] {
    const scale = Math.min(this.canvas.width, this.canvas.height) / 18;
    return [this.canvas.width / 2 + x * scale, this.canvas.height / 2 + z * scale];
  }

  private drawPrimitive(primitive: RenderPrimitive): void {
    if (primitive.shape === 'line') return;
    const ctx = this.context;
    const [x, y] = this.point(primitive.position);
    const unit = Math.min(this.canvas.width, this.canvas.height) / 18;
    const w = Math.max(7, primitive.scale[0] * unit);
    const h = Math.max(7, primitive.scale[2] * unit);
    ctx.fillStyle = css(primitive.color);
    ctx.strokeStyle = css([primitive.color[0], primitive.color[1], primitive.color[2], 1]);
    ctx.lineWidth = primitive.kind === 'room' ? 3 : 1.5;
    if (primitive.shape === 'sphere' || primitive.shape === 'cylinder' || primitive.shape === 'capsule') {
      ctx.beginPath(); ctx.arc(x, y, Math.max(5, Math.min(w, h) / 2), 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    } else {
      ctx.fillRect(x - w / 2, y - h / 2, w, h); ctx.strokeRect(x - w / 2, y - h / 2, w, h);
    }
    ctx.fillStyle = '#e9f2ff'; ctx.font = `${Math.max(11, this.canvas.width / 75)}px ui-monospace, monospace`;
    const labelX = primitive.kind === 'room' ? x - w / 2 + 10 : x + 8;
    const labelY = primitive.kind === 'room' ? y - h / 2 + 20 : y - 8;
    ctx.fillText(primitive.label, labelX, labelY);
  }

  private grid(): void {
    const ctx = this.context; const step = Math.min(this.canvas.width, this.canvas.height) / 18;
    ctx.strokeStyle = 'rgba(111, 155, 205, .12)'; ctx.lineWidth = 1;
    for (let x = this.canvas.width / 2 % step; x < this.canvas.width; x += step) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, this.canvas.height); ctx.stroke();
    }
    for (let y = this.canvas.height / 2 % step; y < this.canvas.height; y += step) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(this.canvas.width, y); ctx.stroke();
    }
  }
}

function css(color: Rgba): string {
  return `rgba(${Math.round(color[0] * 255)},${Math.round(color[1] * 255)},${Math.round(color[2] * 255)},${color[3]})`;
}
