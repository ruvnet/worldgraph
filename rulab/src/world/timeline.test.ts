import { describe, expect, it } from 'vitest';
import type { WorldFrame } from '../contracts';
import { ENTITY_IDS, MAX_EVENTS_PER_BRANCH, MAX_TIMELINE_BYTES, MOTION_CONSTRAINTS, SCENARIOS, TimelineStore, sampleAmrPath } from './timeline';

const entity = (frame: WorldFrame, id: string) => frame.entities.find(value => value.id === id)!;
const exported = (store = new TimelineStore()) => JSON.parse(store.exportJson());

describe('deterministic temporal world', () => {
  it('produces identical frames when seeking directly, stepping, or rewinding', () => {
    const store = new TimelineStore();
    store.record({ kind: 'pause-agent', entityId: 'amr-1', value: true }, 7);
    store.record({ kind: 'pause-agent', entityId: 'amr-1', value: false }, 19);
    store.record({ kind: 'door', entityId: 'rf-door', value: true }, 15);
    const direct = store.seek(37.5);
    for (let time = 0; time < 120; time += 0.1) store.seek(time);
    expect(store.seek(37.5)).toEqual(direct);
    expect(TimelineStore.fromJson(store.exportJson()).seek(37.5)).toEqual(direct);
  });

  it('freezes each agent clock and resumes continuously without teleporting', () => {
    for (const id of ['amr-1', 'robot-1', 'drone-1']) {
      const store = new TimelineStore();
      const original = new TimelineStore();
      store.record({ kind: 'pause-agent', entityId: id, value: true }, 10);
      store.record({ kind: 'pause-agent', entityId: id, value: false }, 20);
      expect(entity(store.seek(10), id)).toEqual(entity(store.seek(19.9), id));
      expect(entity(store.seek(20), id)).toEqual(entity(original.seek(10), id));
      expect(entity(store.seek(31.5), id)).toEqual(entity(original.seek(21.5), id));
    }
  });

  it('uses timestamp then sequence order for edits recorded after a rewind', () => {
    const store = new TimelineStore();
    store.record({ kind: 'pause-agent', entityId: 'amr-1', value: false }, 20);
    store.record({ kind: 'pause-agent', entityId: 'amr-1', value: true }, 10);
    const frame = store.seek(30);
    expect(frame.events.map(event => event.sequence)).toEqual([2, 1]);
    expect(entity(frame, 'amr-1')).toEqual(entity(new TimelineStore().seek(20), 'amr-1'));
    store.record({ kind: 'pause-agent', entityId: 'amr-1', value: true }, 20);
    expect(entity(store.seek(50), 'amr-1')).toEqual(entity(new TimelineStore().seek(10), 'amr-1'));
  });

  it('keeps door reversals continuous and bounded', () => {
    const store = new TimelineStore();
    store.record({ kind: 'door', entityId: 'rf-door', value: true }, 3);
    const halfway = entity(store.seek(3.6), 'rf-door').yaw;
    expect(halfway).toBeCloseTo(Math.PI / 4, 12);
    store.record({ kind: 'door', entityId: 'rf-door', value: false }, 3.6);
    expect(entity(store.seek(3.6), 'rf-door').yaw).toBeCloseTo(halfway, 12);
    expect(entity(store.seek(5), 'rf-door').yaw).toBe(0);
    expect(entity(store.seek(2), 'rf-door').yaw).toBe(0);
  });

  it('isolates all scenario branches and preserves them in exports', () => {
    const store = new TimelineStore();
    store.record({ kind: 'door', entityId: 'rf-door', value: true }, 0);
    store.setScenario('healthcare');
    expect(store.getFrame().time).toBe(0);
    expect(entity(store.seek(10), 'rf-door').yaw).toBe(0);
    store.record({ kind: 'pause-agent', entityId: 'amr-1', value: true });
    store.setScenario('hospitality');
    expect(store.seek(10).events).toEqual([]);
    const restored = TimelineStore.fromJson(store.exportJson());
    restored.setScenario('robotics');
    expect(entity(restored.seek(10), 'rf-door').yaw).toBe(Math.PI / 2);
    restored.setScenario('healthcare');
    expect(restored.seek(10).events).toHaveLength(1);
  });

  it('does not expose mutable authoritative references', () => {
    const store = new TimelineStore();
    const event = store.record({ kind: 'door', entityId: 'rf-door', value: true }, 1);
    event.value = false;
    const frame = store.seek(5);
    frame.events[0]!.value = false;
    frame.entities[0]!.position[0] = 999;
    frame.entities[0]!.joints[0] = 999;
    expect(store.getFrame().events[0]!.value).toBe(true);
    expect(entity(store.getFrame(), 'robot-1').position).toEqual([0, 2, 0]);
    expect(entity(store.getFrame(), 'rf-door').yaw).toBe(Math.PI / 2);
  });

  it('clamps finite seeks while rejecting nonfinite times and invalid actions', () => {
    const store = new TimelineStore();
    expect(store.seek(-500).time).toBe(0);
    expect(store.seek(500).time).toBe(120);
    for (const time of [NaN, Infinity, -Infinity]) expect(() => store.seek(time)).toThrow();
    for (const time of [-1, 121, Infinity, NaN]) expect(() => store.record({ kind: 'door', entityId: 'rf-door', value: true }, time)).toThrow();
    for (const input of [
      { kind: 'door', entityId: 'amr-1', value: true },
      { kind: 'pause-agent', entityId: 'sensor-1', value: true },
      { kind: 'door', entityId: 'rf-door', value: 'false' },
      { kind: 'door', entityId: 'rf-door', value: true, constructor: 'hostile' },
    ]) expect(() => store.record(input as never)).toThrow();
    expect(store.getFrame().revision).toBe(0);
  });

  it('retains ENU identity and authored provenance across every scenario', () => {
    for (const scenario of SCENARIOS) {
      const frame = new TimelineStore(scenario).seek(51);
      expect(frame.entities.map(value => value.id)).toEqual(ENTITY_IDS);
      expect(frame.entities.every(value => value.source === 'authored')).toBe(true);
      expect(entity(frame, 'robot-1').position).toEqual([0, 2, 0]);
      expect(entity(frame, 'rf-door').position).toEqual([9, 3, 0]);
      expect(entity(frame, 'sensor-1').position).toEqual([-8, 4, 3]);
    }
  });

  it('respects authored body envelopes and robot clearance throughout all trajectories', () => {
    const { amr, robot, drone } = MOTION_CONSTRAINTS;
    for (const scenario of SCENARIOS) {
      const store = new TimelineStore(scenario);
      for (let time = 0; time <= store.duration; time += 0.25) {
        const frame = store.seek(time);
        const [e, n, u] = entity(frame, 'amr-1').position;
        expect(e).toBeGreaterThanOrEqual(amr.minEast - 1e-10);
        expect(e).toBeLessThanOrEqual(amr.maxEast + 1e-10);
        expect(n).toBeGreaterThanOrEqual(amr.minNorth - 1e-10);
        expect(n).toBeLessThanOrEqual(amr.maxNorth + 1e-10);
        expect(u).toBe(0);
        expect(Math.hypot(e - robot.east, n - robot.north) - amr.bodyRadius).toBeGreaterThan(robot.exclusionRadius);
        const altitude = entity(frame, 'drone-1').position[2];
        expect(altitude).toBeGreaterThanOrEqual(drone.minUp - 1e-10);
        expect(altitude).toBeLessThanOrEqual(drone.maxUp + 1e-10);
        expect(altitude - drone.bodyRadius).toBeGreaterThan(robot.maxHeight);
      }
    }
  });

  it('makes the AMR path continuous at corners and at loop closure', () => {
    let last = sampleAmrPath(0).position;
    for (let time = 0.05; time <= 120; time += 0.05) {
      const next = sampleAmrPath(time).position;
      expect(Math.hypot(next[0] - last[0], next[1] - last[1])).toBeLessThanOrEqual(0.52 * 0.05 + 1e-10);
      last = next;
    }
  });
});

describe('bounded untrusted timeline import', () => {
  it('round trips canonically and accepts identical event retransmissions idempotently', () => {
    const store = new TimelineStore();
    store.record({ kind: 'door', entityId: 'rf-door', value: true }, 2);
    const data = exported(store);
    data.branches[0].events.push({ ...data.branches[0].events[0] });
    expect(TimelineStore.fromJson(JSON.stringify(data)).exportJson()).toBe(store.exportJson());
  });

  it('rejects conflicting duplicate identities and nonmonotonic edit sequences', () => {
    const store = new TimelineStore();
    store.record({ kind: 'door', entityId: 'rf-door', value: true }, 10);
    store.record({ kind: 'door', entityId: 'rf-door', value: false }, 20);
    const conflict = exported(store);
    conflict.branches[0].events.push({ ...conflict.branches[0].events[0], value: false });
    expect(() => TimelineStore.fromJson(JSON.stringify(conflict))).toThrow(/Conflicting/);
    const reversed = exported(store);
    reversed.branches[0].events.reverse();
    expect(() => TimelineStore.fromJson(JSON.stringify(reversed))).toThrow(/monotonically/);
  });

  it('rejects hostile properties at every schema boundary without prototype mutation', () => {
    const store = new TimelineStore();
    store.record({ kind: 'door', entityId: 'rf-door', value: true });
    for (const path of ['root', 'branch', 'event']) {
      for (const property of ['__proto__', 'constructor', 'prototype', 'unknown']) {
        const data = exported(store);
        const target = path === 'root' ? data : path === 'branch' ? data.branches[0] : data.branches[0].events[0];
        Object.defineProperty(target, property, { value: { polluted: true }, enumerable: true });
        expect(() => TimelineStore.fromJson(JSON.stringify(data))).toThrow(/unsupported properties/);
      }
    }
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
  });

  it('rejects malformed, oversized, incompatible, or incomplete documents', () => {
    expect(() => TimelineStore.fromJson('{')).toThrow();
    expect(() => TimelineStore.fromJson(' '.repeat(MAX_TIMELINE_BYTES + 1))).toThrow(/limit/);
    const mutations = [
      (data: any) => { data.version = 2; },
      (data: any) => { data.duration = 1e300; },
      (data: any) => { data.time = -1; },
      (data: any) => { data.time = '20'; },
      (data: any) => { data.scenario = '__proto__'; },
      (data: any) => { data.branches.pop(); },
      (data: any) => { data.branches[1].scenario = 'robotics'; },
      (data: any) => { data.branches[0].events = {}; },
      (data: any) => { data.branches[0].events = new Array(MAX_EVENTS_PER_BRANCH + 1).fill(null); },
    ];
    for (const mutate of mutations) {
      const data = exported();
      mutate(data);
      expect(() => TimelineStore.fromJson(JSON.stringify(data))).toThrow();
    }
  });

  it('rejects invalid event identities, values, numbers, and entity/action pairings', () => {
    const store = new TimelineStore();
    store.record({ kind: 'door', entityId: 'rf-door', value: true });
    for (const patch of [
      { id: 'evt-healthcare-1' }, { sequence: 0 }, { sequence: 1.5 }, { sequence: Number.MAX_SAFE_INTEGER + 1 },
      { time: 121 }, { time: null }, { value: 1 }, { entityId: 'drone-1' }, { kind: 'execute' },
    ]) {
      const data = exported(store);
      Object.assign(data.branches[0].events[0], patch);
      expect(() => TimelineStore.fromJson(JSON.stringify(data))).toThrow();
    }
  });

  it('bounds local recording and allows safe continuation after imported gaps', () => {
    const store = new TimelineStore();
    for (let i = 0; i < MAX_EVENTS_PER_BRANCH; i++) store.record({ kind: 'door', entityId: 'rf-door', value: i % 2 === 0 });
    expect(() => store.record({ kind: 'door', entityId: 'rf-door', value: true })).toThrow(/limit/);
    const data = exported(store);
    data.branches[0].events = [data.branches[0].events[100]];
    const imported = TimelineStore.fromJson(JSON.stringify(data));
    expect(imported.record({ kind: 'door', entityId: 'rf-door', value: false }).sequence).toBe(102);
  });

  it('round trips the final safe sequence and rejects the next record without mutation', () => {
    const seed = new TimelineStore();
    seed.record({ kind: 'door', entityId: 'rf-door', value: true }, 2);
    const data = exported(seed);
    const penultimate = Number.MAX_SAFE_INTEGER - 1;
    data.branches[0].events[0].sequence = penultimate;
    data.branches[0].events[0].id = `evt-robotics-${penultimate}`;
    const store = TimelineStore.fromJson(JSON.stringify(data));
    expect(store.record({ kind: 'door', entityId: 'rf-door', value: false }, 4).sequence).toBe(Number.MAX_SAFE_INTEGER);
    const finalExport = store.exportJson();
    const restored = TimelineStore.fromJson(finalExport);
    expect(restored.exportJson()).toBe(finalExport);
    expect(restored.seek(8)).toEqual(store.seek(8));
    for (const exhausted of [store, restored]) {
      const before = exhausted.exportJson();
      expect(() => exhausted.record({ kind: 'door', entityId: 'rf-door', value: true }, 6)).toThrow(RangeError);
      expect(exhausted.exportJson()).toBe(before);
    }
  });
});
