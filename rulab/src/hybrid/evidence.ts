/**
 * Read-only display projection for an already authorized evidence snapshot.
 * These checks validate display eligibility, NOT identity or source authenticity.
 * `live`, `replay`, hashes and matching scope strings are never authentication.
 * A production adapter must verify the source and supply its own trusted context.
 */
export type EvidenceSource = 'synthetic' | 'replay' | 'live';
export type EvidencePosition = [number, number, number];

interface RegionClock { id: string; capturedAtMs: number; validUntilMs: number }
export type EvidenceRegion =
  | (RegionClock & { evidence: 'count-only'; count: number })
  | (RegionClock & { evidence: 'observed' | 'estimated'; position: EvidencePosition; radiusM: number });

export interface EvidenceSnapshot {
  schema: 'worldgraph.hybrid.evidence.v1';
  source: EvidenceSource;
  tenantId: string;
  spaceId: string;
  calibrationId: string;
  privacyEpoch: number;
  registrationId: string;
  coordinateSystem: 'right-handed-y-up';
  units: 'metres';
  capturedAtMs: number;
  validUntilMs: number;
  regions: EvidenceRegion[];
}

/** Scene registration is supplied by the host, not inferred from appearance. */
export interface EvidenceContext {
  tenantId: string;
  spaceId: string;
  calibrationId: string;
  privacyEpoch: number;
  registrationId: string;
  maxAgeMs: number;
}

export interface EvidenceProjection {
  markers: Array<{ id: string; position: EvidencePosition; radiusM: number; evidence: 'observed' | 'estimated' }>;
  counts: Array<{ id: string; count: number }>;
  rejected: boolean;
  reason: string;
  sourceAgeMs: number | null;
}

export const MAX_EVIDENCE_REGIONS = 128;
export const MAX_EVIDENCE_AGE_MS = 60_000;
export const MAX_EVIDENCE_COORDINATE_M = 10_000;

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const snapshotKeys = ['schema', 'source', 'tenantId', 'spaceId', 'calibrationId', 'privacyEpoch', 'registrationId', 'coordinateSystem', 'units', 'capturedAtMs', 'validUntilMs', 'regions'];
const contextKeys = ['tenantId', 'spaceId', 'calibrationId', 'privacyEpoch', 'registrationId', 'maxAgeMs'];
const countKeys = ['id', 'evidence', 'count', 'capturedAtMs', 'validUntilMs'];
const locatedKeys = ['id', 'evidence', 'position', 'radiusM', 'capturedAtMs', 'validUntilMs'];

function record(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && Reflect.ownKeys(value).every(key =>
    Object.prototype.hasOwnProperty.call(Object.getOwnPropertyDescriptor(value, key), 'value'));
}
function exactFields(value: Record<string, unknown>, fields: string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === fields.length && keys.every(key => typeof key === 'string' && fields.includes(key)
    && Object.prototype.hasOwnProperty.call(Object.getOwnPropertyDescriptor(value, key), 'value'));
}
function id(value: unknown): value is string { return typeof value === 'string' && ID.test(value); }
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}
function finite(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}
function position(value: unknown): value is EvidencePosition {
  return Array.isArray(value) && value.length === 3 && [value[0], value[1], value[2]].every(axis => finite(axis, -MAX_EVIDENCE_COORDINATE_M, MAX_EVIDENCE_COORDINATE_M));
}
function reject(reason: string, sourceAgeMs: number | null = null): EvidenceProjection {
  return { markers: [], counts: [], rejected: true, reason, sourceAgeMs };
}
function scopeShape(value: Record<string, unknown>): boolean {
  return id(value.tenantId) && id(value.spaceId) && id(value.calibrationId) && id(value.registrationId) && integer(value.privacyEpoch);
}

/**
 * No interpolation, localization from counts, state mutation, or network calls.
 * All coordinates are local right handed Y-up metres. The application must retain
 * the source declaration visibly; an accepted synthetic input stays synthetic.
 * Times use one caller-selected millisecond clock (wall clock or replay clock).
 * Expiry is exclusive. The global TTL and max age both gate all output.
 */
export function projectEvidence(snapshot: unknown, context: EvidenceContext, nowMs: number): EvidenceProjection {
  if (!record(context) || !exactFields(context, contextKeys) || !scopeShape(context)
    || !integer(context.maxAgeMs, 1, MAX_EVIDENCE_AGE_MS) || !integer(nowMs)) return reject('Invalid display context or clock.');
  if (!record(snapshot) || !exactFields(snapshot, snapshotKeys) || !scopeShape(snapshot)) return reject('Invalid evidence envelope.');
  if (snapshot.schema !== 'worldgraph.hybrid.evidence.v1'
    || typeof snapshot.source !== 'string' || !['synthetic', 'replay', 'live'].includes(snapshot.source)) return reject('Unsupported evidence schema or source.');
  if (snapshot.coordinateSystem !== 'right-handed-y-up' || snapshot.units !== 'metres') return reject('Unregistered coordinate frame or units.');
  for (const field of ['tenantId', 'spaceId', 'calibrationId', 'privacyEpoch', 'registrationId'] as const) {
    if (snapshot[field] !== context[field]) return reject(`Evidence ${field} does not match this scene.`);
  }
  if (!integer(snapshot.capturedAtMs) || !integer(snapshot.validUntilMs)
    || snapshot.validUntilMs <= snapshot.capturedAtMs) return reject('Invalid source clocks.');
  const sourceAgeMs = nowMs - snapshot.capturedAtMs;
  if (sourceAgeMs < 0) return reject('Evidence capture is in the future.');
  if (nowMs >= snapshot.validUntilMs || sourceAgeMs > context.maxAgeMs) return reject('Evidence expired.', sourceAgeMs);
  if (!Array.isArray(snapshot.regions) || snapshot.regions.length > MAX_EVIDENCE_REGIONS) return reject('Evidence region limit exceeded or invalid.', sourceAgeMs);

  const result: EvidenceProjection = { markers: [], counts: [], rejected: false, reason: 'Evidence eligible for display.', sourceAgeMs };
  const seen = new Set<string>();
  let expired = 0;
  for (const candidate of snapshot.regions) {
    if (!record(candidate) || !id(candidate.id)) return reject('Invalid evidence region.', sourceAgeMs);
    if (seen.has(candidate.id)) return reject('Duplicate evidence region identity.', sourceAgeMs);
    seen.add(candidate.id);
    const countOnly = candidate.evidence === 'count-only';
    if (!countOnly && candidate.evidence !== 'observed' && candidate.evidence !== 'estimated') return reject('Unsupported region evidence.', sourceAgeMs);
    if (!exactFields(candidate, countOnly ? countKeys : locatedKeys)) return reject('Invalid region fields; counts cannot supply coordinates.', sourceAgeMs);
    if (!integer(candidate.capturedAtMs) || !integer(candidate.validUntilMs)
      || candidate.validUntilMs <= candidate.capturedAtMs || candidate.capturedAtMs > snapshot.capturedAtMs
      || candidate.validUntilMs > snapshot.validUntilMs) return reject('Invalid region clocks.', sourceAgeMs);
    if (countOnly ? !integer(candidate.count, 0, 65_535)
      : !position(candidate.position) || !finite(candidate.radiusM, .01, 100)) return reject('Invalid region measurement.', sourceAgeMs);
    if (nowMs >= candidate.validUntilMs || nowMs - candidate.capturedAtMs > context.maxAgeMs) { expired++; continue; }
    if (countOnly) result.counts.push({ id: candidate.id, count: candidate.count as number });
    else result.markers.push({ id: candidate.id, position: [...candidate.position as EvidencePosition], radiusM: candidate.radiusM as number,
      evidence: candidate.evidence as 'observed' | 'estimated' });
  }
  if (expired) result.reason = `${expired} expired region${expired === 1 ? '' : 's'} omitted.`;
  return result;
}
