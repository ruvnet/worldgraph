import type { EntityState, ScenarioId, TimelineEvent, Vec3, WorldFrame } from '../contracts';

/** All dimensions are authored metres in East, North, Up, not surveyed geometry. */
export const SCENE_BOUNDS = Object.freeze({ minEast: -12, maxEast: 12, minNorth: -17, maxNorth: 17, ceiling: 11 });
export const RF_ROOM_BOUNDS = Object.freeze({ minEast: 7.7, maxEast: 12, minNorth: -0.2, maxNorth: 6.2 });
export const MOTION_CONSTRAINTS = Object.freeze({
  amr: Object.freeze({ minEast: -2.6, maxEast: 2.6, minNorth: -6.5, maxNorth: 5.6, cornerRadius: 0.8, bodyRadius: 0.55 }),
  robot: Object.freeze({ east: 0, north: 2, exclusionRadius: 1.65, maxHeight: 3.3 }),
  drone: Object.freeze({ eastRadius: 3, northRadius: 2, minUp: 4.6, maxUp: 5, bodyRadius: 0.45 }),
});
export const SCENARIOS: readonly ScenarioId[] = Object.freeze(['robotics', 'hospitality', 'healthcare']);
export const ENTITY_IDS = Object.freeze(['robot-1', 'amr-1', 'drone-1', 'rf-door', 'sensor-1', 'sensor-2'] as const);
export const MAX_EVENTS_PER_BRANCH = 1024;
export const MAX_TIMELINE_BYTES = 1024 * 1024;
export const TIMELINE_DURATION = 120;

type EventInput = Pick<TimelineEvent, 'kind' | 'entityId' | 'value'>;
type RecordObject = Record<string, unknown>;
const AGENTS = new Set<string>(['robot-1', 'amr-1', 'drone-1']);
const TAU = Math.PI * 2;

function object(value: unknown, keys: readonly string[], location: string): RecordObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(`${location} must be a plain object`);
  }
  const record = value as RecordObject;
  const actual = Object.keys(record);
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key)) ||
      keys.some(key => !Object.hasOwn(record, key))) {
    throw new TypeError(`${location} has missing or unsupported properties`);
  }
  return record;
}

function scenarioId(value: unknown): ScenarioId {
  if (typeof value !== 'string' || !SCENARIOS.includes(value as ScenarioId)) throw new TypeError('Unknown RuLab scenario');
  return value as ScenarioId;
}

function finiteTime(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('Time must be finite seconds');
  return value;
}

function boundedTime(value: unknown): number {
  const time = finiteTime(value);
  if (time < 0 || time > TIMELINE_DURATION) throw new RangeError('Time must be between 0 and 120 seconds');
  return Object.is(time, -0) ? 0 : time;
}

function eventInput(value: unknown): EventInput {
  const input = object(value, ['kind', 'entityId', 'value'], 'Event');
  if (typeof input.value !== 'boolean' || typeof input.entityId !== 'string') throw new TypeError('Invalid event value or entity');
  if (input.kind === 'door' && input.entityId === 'rf-door') return { kind: input.kind, entityId: input.entityId, value: input.value };
  if (input.kind === 'pause-agent' && AGENTS.has(input.entityId)) return { kind: input.kind, entityId: input.entityId, value: input.value };
  throw new TypeError('Action is not supported by this entity');
}

const copyEvent = (event: TimelineEvent): TimelineEvent => ({ id: event.id, time: event.time, sequence: event.sequence,
  kind: event.kind, entityId: event.entityId, value: event.value });
const chronological = (a: TimelineEvent, b: TimelineEvent): number => a.time - b.time || a.sequence - b.sequence;
const eventId = (scenario: ScenarioId, sequence: number): string => `evt-${scenario}-${sequence}`;

/** Integrate unpaused time analytically, making reverse seeks independent of frame rate. */
function agentTime(id: string, time: number, events: readonly TimelineEvent[]): number {
  let previous = 0;
  let active = 0;
  let paused = false;
  for (const event of events) {
    if (event.kind !== 'pause-agent' || event.entityId !== id) continue;
    if (!paused) active += event.time - previous;
    previous = event.time;
    paused = event.value;
  }
  return active + (paused ? 0 : time - previous);
}

/** A rounded rectangle, parameterized by arc length. Yaw 0 = East, +pi/2 = North. */
export function sampleAmrPath(seconds: number, speed = 0.52): { position: Vec3; yaw: number } {
  finiteTime(seconds);
  if (!Number.isFinite(speed) || speed <= 0 || speed > 2) throw new RangeError('AMR speed must be in (0, 2] m/s');
  const { minEast: left, maxEast: right, minNorth: bottom, maxNorth: top, cornerRadius: radius } = MOTION_CONSTRAINTS.amr;
  const width = right - left - radius * 2;
  const height = top - bottom - radius * 2;
  const arc = Math.PI * radius / 2;
  const perimeter = 2 * width + 2 * height + 4 * arc;
  let distance = ((seconds * speed) % perimeter + perimeter) % perimeter;
  const segments = [width, arc, height, arc, width, arc, height, arc];
  let segment = 0;
  while (segment < 7 && distance >= segments[segment]!) distance -= segments[segment++]!;
  let east: number;
  let north: number;
  let yaw: number;
  if (segment === 0) { east = left + radius + distance; north = bottom; yaw = 0; }
  else if (segment === 2) { east = right; north = bottom + radius + distance; yaw = Math.PI / 2; }
  else if (segment === 4) { east = right - radius - distance; north = top; yaw = Math.PI; }
  else if (segment === 6) { east = left; north = top - radius - distance; yaw = -Math.PI / 2; }
  else {
    const corner = (segment - 1) / 2;
    const centers = [[right - radius, bottom + radius], [right - radius, top - radius], [left + radius, top - radius], [left + radius, bottom + radius]];
    const angle = -Math.PI / 2 + corner * Math.PI / 2 + distance / radius;
    east = centers[corner]![0]! + radius * Math.cos(angle);
    north = centers[corner]![1]! + radius * Math.sin(angle);
    yaw = angle + Math.PI / 2;
  }
  return { position: [east, north, 0], yaw: Math.atan2(Math.sin(yaw), Math.cos(yaw)) };
}

/** Returns joint angle in radians. Rapid open/close reversals stay continuous. */
function doorAngle(time: number, events: readonly TimelineEvent[]): number {
  let from = 0;
  let target = 0;
  let start = 0;
  const at = (t: number): number => {
    const alpha = Math.min(1, Math.max(0, (t - start) / 1.2));
    return from + (target - from) * alpha * alpha * (3 - 2 * alpha);
  };
  for (const event of events) {
    if (event.kind !== 'door') continue;
    from = at(event.time);
    target = event.value ? Math.PI / 2 : 0;
    start = event.time;
  }
  return at(time);
}

const rates: Record<ScenarioId, { robot: number; amr: number; drone: number; robotLabel: string; amrLabel: string }> = {
  robotics: { robot: 1, amr: 0.52, drone: 1, robotLabel: 'Articulated research arm', amrLabel: 'Autonomous mobile platform' },
  hospitality: { robot: 0.7, amr: 0.4, drone: 0.65, robotLabel: 'Service manipulation station', amrLabel: 'Guest service delivery robot' },
  healthcare: { robot: 0.5, amr: 0.32, drone: 0.45, robotLabel: 'Care simulation manipulator', amrLabel: 'Clinical supply delivery robot' },
};

function entitiesAt(time: number, scenario: ScenarioId, events: readonly TimelineEvent[]): EntityState[] {
  const rate = rates[scenario];
  const robotTime = agentTime('robot-1', time, events) * rate.robot;
  const droneTime = agentTime('drone-1', time, events) * rate.drone;
  const amr = sampleAmrPath(agentTime('amr-1', time, events), rate.amr);
  const phase = droneTime * TAU / 48;
  const angle = doorAngle(time, events);
  const base = { source: 'authored' as const, confidence: 1 };
  return [
    { ...base, id: 'robot-1', kind: 'robot', label: rate.robotLabel, position: [0, 2, 0], yaw: 0,
      joints: [Math.sin(robotTime * 0.18) * 0.65, -0.35 + Math.sin(robotTime * 0.23) * 0.22, 0.85 + Math.sin(robotTime * 0.23 + 0.8) * 0.28, Math.sin(robotTime * 0.3) * 0.4, 0.35, Math.sin(robotTime * 0.4) * 0.22] },
    { ...base, id: 'amr-1', kind: 'amr', label: rate.amrLabel, ...amr, joints: [] },
    { ...base, id: 'drone-1', kind: 'drone', label: 'Indoor research drone', position: [3 * Math.sin(phase), 2 * Math.cos(phase), 4.8 + 0.2 * Math.sin(phase * 2)], yaw: Math.atan2(-2 * Math.sin(phase), 3 * Math.cos(phase)), joints: [droneTime * 35 % TAU] },
    { ...base, id: 'rf-door', kind: 'door', label: 'RF chamber door', position: [9, 3, 0], yaw: angle, joints: [angle] },
    { ...base, id: 'sensor-1', kind: 'sensor', label: 'Authored UWB reference anchor', position: [-8, 4, 3], yaw: 0, joints: [] },
    { ...base, id: 'sensor-2', kind: 'sensor', label: 'Authored WiFi CSI sensor', position: [8, -4, 3], yaw: 0, joints: [] },
  ];
}

/**
 * Bounded event-sourced concept simulation. It does not run a learned predictor,
 * observe equipment, or establish collision safety outside the authored envelopes.
 * Returned values are copies; callers cannot mutate the authoritative timeline.
 */
export class TimelineStore {
  readonly duration = TIMELINE_DURATION;
  private scenario: ScenarioId;
  private time = 0;
  private readonly branches = new Map<ScenarioId, TimelineEvent[]>(SCENARIOS.map(id => [id, []]));

  constructor(scenario: ScenarioId = 'robotics') { this.scenario = scenarioId(scenario); }

  seek(seconds: number): WorldFrame {
    this.time = Math.min(this.duration, Math.max(0, finiteTime(seconds)));
    return this.getFrame();
  }

  getFrame(): WorldFrame {
    const branch = this.branches.get(this.scenario)!;
    const applied = branch.filter(event => event.time <= this.time).sort(chronological);
    return { version: 1, time: this.time, scenario: this.scenario, revision: branch.at(-1)?.sequence ?? 0,
      entities: entitiesAt(this.time, this.scenario, applied), events: applied.map(copyEvent) };
  }

  setScenario(id: ScenarioId): void { this.scenario = scenarioId(id); this.time = 0; }

  record(input: EventInput, time = this.time): TimelineEvent {
    const action = eventInput(input);
    const at = boundedTime(time);
    const branch = this.branches.get(this.scenario)!;
    if (branch.length >= MAX_EVENTS_PER_BRANCH) throw new RangeError('Timeline event limit reached');
    const sequence = (branch.at(-1)?.sequence ?? 0) + 1;
    if (!Number.isSafeInteger(sequence)) throw new RangeError('Timeline sequence limit reached');
    const event: TimelineEvent = { id: eventId(this.scenario, sequence), time: at, sequence, ...action };
    branch.push(event);
    return copyEvent(event);
  }

  exportJson(): string {
    return JSON.stringify({ format: 'worldgraph.rulab.timeline', version: 1, duration: this.duration,
      scenario: this.scenario, time: this.time,
      branches: SCENARIOS.map(scenario => ({ scenario, events: this.branches.get(scenario)!.map(copyEvent) })) }, null, 2);
  }

  /** Parsing is transactional: no live store changes until the entire document validates. */
  static fromJson(json: string): TimelineStore {
    if (typeof json !== 'string' || json.length > MAX_TIMELINE_BYTES || new TextEncoder().encode(json).byteLength > MAX_TIMELINE_BYTES) {
      throw new RangeError('Timeline JSON exceeds the 1 MiB limit');
    }
    const root = object(JSON.parse(json) as unknown, ['format', 'version', 'duration', 'scenario', 'time', 'branches'], 'Timeline');
    if (root.format !== 'worldgraph.rulab.timeline' || root.version !== 1 || root.duration !== TIMELINE_DURATION) {
      throw new TypeError('Unsupported timeline format or version');
    }
    const scenario = scenarioId(root.scenario);
    const time = boundedTime(root.time);
    if (!Array.isArray(root.branches) || root.branches.length !== SCENARIOS.length) throw new TypeError('Exactly three scenario branches are required');
    const store = new TimelineStore(scenario);
    const seenBranches = new Set<ScenarioId>();
    for (const rawBranch of root.branches) {
      const branch = object(rawBranch, ['scenario', 'events'], 'Branch');
      const id = scenarioId(branch.scenario);
      if (seenBranches.has(id)) throw new TypeError('Duplicate scenario branch');
      seenBranches.add(id);
      if (!Array.isArray(branch.events) || branch.events.length > MAX_EVENTS_PER_BRANCH) throw new RangeError('Invalid branch event count');
      const canonical: TimelineEvent[] = [];
      const seen = new Map<string, TimelineEvent>();
      for (const raw of branch.events) {
        const record = object(raw, ['id', 'time', 'sequence', 'kind', 'entityId', 'value'], 'Timeline event');
        if (typeof record.sequence !== 'number' || !Number.isSafeInteger(record.sequence) || record.sequence < 1) {
          throw new TypeError('Event sequence must be a positive safe integer');
        }
        if (record.id !== eventId(id, record.sequence)) throw new TypeError('Event identity does not match branch and sequence');
        const action = eventInput({ kind: record.kind, entityId: record.entityId, value: record.value });
        const event: TimelineEvent = { id: record.id, sequence: record.sequence, time: boundedTime(record.time), ...action };
        const duplicate = seen.get(event.id);
        if (duplicate) {
          if (JSON.stringify(duplicate) !== JSON.stringify(event)) throw new TypeError('Conflicting duplicate event identity');
          continue; // Retransmitting an identical event is idempotent.
        }
        if (event.sequence <= (canonical.at(-1)?.sequence ?? 0)) throw new TypeError('Event sequences must increase monotonically');
        seen.set(event.id, event);
        canonical.push(event);
      }
      store.branches.set(id, canonical);
    }
    store.time = time;
    return store;
  }
}
