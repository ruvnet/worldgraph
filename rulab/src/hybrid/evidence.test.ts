import { describe, expect, it } from 'vitest';
import { projectEvidence, MAX_EVIDENCE_REGIONS, type EvidenceSnapshot, type EvidenceContext } from './evidence';

const context: EvidenceContext = { tenantId: 'local-demo', spaceId: 'coast', calibrationId: 'authored-v1', privacyEpoch: 1, registrationId: 'coast-y-up-v1', maxAgeMs: 500 };
function fixture(): EvidenceSnapshot {
  return { schema: 'worldgraph.hybrid.evidence.v1', source: 'synthetic', tenantId: context.tenantId, spaceId: context.spaceId,
    calibrationId: context.calibrationId, privacyEpoch: context.privacyEpoch, registrationId: context.registrationId,
    coordinateSystem: 'right-handed-y-up', units: 'metres', capturedAtMs: 1000, validUntilMs: 1500,
    regions: [
      { id: 'tracked-person', evidence: 'estimated', position: [3, 1, -4], radiusM: .8, capturedAtMs: 1000, validUntilMs: 1500 },
      { id: 'unlocated-room', evidence: 'count-only', count: 3, capturedAtMs: 1000, validUntilMs: 1500 },
    ] };
}
function mustReject(value: unknown, ctx = context, now = 1100) {
  const output = projectEvidence(value, ctx, now);
  expect(output.rejected).toBe(true); expect(output.reason.length).toBeGreaterThan(0);
  expect(output.markers).toEqual([]); expect(output.counts).toEqual([]);
}

describe('hybrid display evidence eligibility', () => {
  it('keeps count-only evidence unlocated and preserves explicit uncertainty for located estimates', () => {
    const output = projectEvidence(fixture(), context, 1100);
    expect(output).toEqual({ markers: [{ id: 'tracked-person', evidence: 'estimated', position: [3, 1, -4], radiusM: .8 }],
      counts: [{ id: 'unlocated-room', count: 3 }], rejected: false, reason: 'Evidence eligible for display.', sourceAgeMs: 100 });
  });
  it('accepts zero count without producing an actor position', () => {
    const input = fixture(); input.regions = [{ id: 'empty-room', evidence: 'count-only', count: 0, capturedAtMs: 1000, validUntilMs: 1500 }];
    const output = projectEvidence(input, context, 1100);
    expect(output.rejected).toBe(false); expect(output.markers).toEqual([]); expect(output.counts).toEqual([{ id: 'empty-room', count: 0 }]);
  });
  it('rejects a count-only region carrying invented coordinates instead of silently trusting them', () => {
    const input = fixture(); Object.assign(input.regions[1], { position: [2, 0, 2], radiusM: 1 }); mustReject(input);
  });
  it('does not mutate input and copies output coordinates', () => {
    const input = fixture(), before = structuredClone(input);
    Object.freeze(input); Object.freeze(input.regions); input.regions.forEach(region => { if ('position' in region) Object.freeze(region.position); Object.freeze(region); });
    const output = projectEvidence(input, context, 1100); output.markers[0].position[0] = 88;
    expect(input).toEqual(before); expect(context).toEqual({ tenantId: 'local-demo', spaceId: 'coast', calibrationId: 'authored-v1', privacyEpoch: 1, registrationId: 'coast-y-up-v1', maxAgeMs: 500 });
  });
  it('clears all output at global expiry even if a previous call had visible evidence', () => {
    const input = fixture(); expect(projectEvidence(input, context, 1499).markers).toHaveLength(1);
    const expired = projectEvidence(input, context, 1500);
    expect(expired.rejected).toBe(true); expect(expired.sourceAgeMs).toBe(500); expect(expired.markers).toEqual([]); expect(expired.counts).toEqual([]);
  });
  it('enforces maximum source age independently of declared expiry', () => {
    const input = fixture(); input.validUntilMs = 2000;
    expect(projectEvidence(input, context, 1499).rejected).toBe(false); mustReject(input, context, 1501);
  });
  it('omits only expired individual regions and never carries their previous positions forward', () => {
    const input = fixture(); input.regions[0].validUntilMs = 1100;
    const output = projectEvidence(input, context, 1100);
    expect(output.rejected).toBe(false); expect(output.markers).toEqual([]); expect(output.counts).toHaveLength(1); expect(output.reason).toContain('1 expired region');
  });
  it('omits old individual regions even when the enclosing snapshot is fresh', () => {
    const input = fixture(); input.regions[0].capturedAtMs = 599;
    expect(projectEvidence(input, context, 1100).markers).toEqual([]);
  });
  it.each(['tenantId', 'spaceId', 'calibrationId', 'registrationId'] as const)('rejects a mismatched %s before display', field => {
    const input = fixture(); input[field] = 'different'; mustReject(input);
  });
  it('clears output after privacy epoch changes', () => { mustReject(fixture(), { ...context, privacyEpoch: 2 }); });
  it('requires explicit scene registration', () => { mustReject(fixture(), { ...context, registrationId: '' }); });
  it.each([
    ['coordinate frame', (x: any) => x.coordinateSystem = 'ENU'], ['units', (x: any) => x.units = 'feet'],
    ['schema', (x: any) => x.schema = 'unknown'], ['source', (x: any) => x.source = 'authenticated'],
    ['future capture', (x: any) => x.capturedAtMs = 1200], ['invalid global TTL', (x: any) => x.validUntilMs = 1000],
    ['extra raw data', (x: any) => x.rawCSI = [1]], ['wrong epoch type', (x: any) => x.privacyEpoch = true],
    ['NaN coordinate', (x: any) => x.regions[0].position[0] = NaN], ['infinite radius', (x: any) => x.regions[0].radiusM = Infinity],
    ['negative radius', (x: any) => x.regions[0].radiusM = -.1], ['unbounded radius', (x: any) => x.regions[0].radiusM = 101],
    ['unbounded coordinate', (x: any) => x.regions[0].position[0] = 10001], ['missing coordinate', (x: any) => x.regions[0].position = [0, 1]],
    ['sparse coordinate', (x: any) => x.regions[0].position = new Array(3)],
    ['boolean count', (x: any) => x.regions[1].count = true], ['negative count', (x: any) => x.regions[1].count = -1],
    ['fractional count', (x: any) => x.regions[1].count = 2.1], ['unbounded count', (x: any) => x.regions[1].count = 65536],
    ['duplicate identity', (x: any) => x.regions[1].id = x.regions[0].id], ['predicted location', (x: any) => x.regions[0].evidence = 'predicted'],
    ['region newer than snapshot', (x: any) => x.regions[0].capturedAtMs = 1001], ['region beyond global TTL', (x: any) => x.regions[0].validUntilMs = 1501],
    ['region reverse TTL', (x: any) => x.regions[0].validUntilMs = 999], ['invalid region identity', (x: any) => x.regions[0].id = '<script>'],
  ])('rejects %s without partial output', (_name, mutate) => { const input = fixture(); mutate(input); mustReject(input); });
  it('accepts a bounded empty snapshot and enforces the region cap', () => {
    const input = fixture(); input.regions = []; expect(projectEvidence(input, context, 1100).rejected).toBe(false);
    const count = fixture().regions[1];
    input.regions = Array.from({ length: MAX_EVIDENCE_REGIONS }, (_, i) => ({ ...count, id: `room-${i}` }));
    expect(projectEvidence(input, context, 1100).counts).toHaveLength(MAX_EVIDENCE_REGIONS);
    input.regions.push({ ...count, id: 'extra' }); mustReject(input);
  });
  it.each([null, [], {}, 42, 'snapshot'])('rejects malformed input %j', input => mustReject(input));
  it('rejects inherited or accessor fields without running accessor code', () => {
    const input = fixture(); let accessed = false;
    Object.defineProperty(input, 'source', { enumerable: true, get() { accessed = true; return 'live'; } });
    mustReject(input); expect(accessed).toBe(false);
    mustReject(Object.create(fixture()));
    const regional = fixture();
    Object.defineProperty(regional.regions[0], 'id', { enumerable: true, get() { accessed = true; return 'tracked-person'; } });
    mustReject(regional); expect(accessed).toBe(false);
  });
  it('rejects invalid clocks and contexts', () => {
    for (const now of [NaN, Infinity, -1, 1100.1]) mustReject(fixture(), context, now);
    for (const maxAgeMs of [0, -1, 60_001, Infinity, NaN]) mustReject(fixture(), { ...context, maxAgeMs });
  });
  it('accepts source declarations without authenticating or rewriting them', () => {
    for (const source of ['synthetic', 'replay', 'live'] as const) {
      const input = fixture(); input.source = source;
      expect(projectEvidence(input, context, 1100).rejected).toBe(false); expect(input.source).toBe(source);
    }
  });
});
