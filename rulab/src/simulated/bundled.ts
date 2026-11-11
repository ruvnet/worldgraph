import { openRollout, parseRolloutIndexText, ROLLOUT_INDEX_FORMAT, type RolloutReader } from './manifest';
import type { RolloutBundle, RolloutIndexEntry } from './types';

export const MAX_ROLLOUT_INDEX_BYTES = 16 * 1024;
type Fetch = typeof fetch;

/** Same-origin read with a hard byte bound; a longer body is cancelled, never buffered. */
export async function fetchBounded(url: string, maxBytes: number, signal?: AbortSignal, fetcher: Fetch = fetch): Promise<ArrayBuffer | null> {
  const response = await fetcher(url, { signal, credentials: 'same-origin', cache: 'no-cache' });
  if (!response.ok) return null;
  if (!response.body) throw new Error('Rollout response has no readable body.');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new RangeError(`Rollout file exceeds its ${maxBytes} byte limit.`); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes.buffer;
}

/**
 * List bundled rollouts from `<base>simulated/index.json`. A missing index, a static-host
 * fallback page, or any document that is not a rollout index means "none bundled". A document
 * that claims the index format but is malformed is an error worth showing.
 */
export async function loadRolloutIndex(base: string, signal?: AbortSignal, fetcher: Fetch = fetch): Promise<readonly RolloutIndexEntry[]> {
  let source: string;
  try {
    const bytes = await fetchBounded(`${base}simulated/index.json`, MAX_ROLLOUT_INDEX_BYTES, signal, fetcher);
    if (!bytes) return [];
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const claimed: unknown = JSON.parse(source);
    if (!claimed || typeof claimed !== 'object' || (claimed as { format?: unknown }).format !== ROLLOUT_INDEX_FORMAT) return [];
  } catch (error) {
    if (signal?.aborted) throw error;
    return [];
  }
  return parseRolloutIndexText(source);
}

/** Open one indexed rollout. Every file is a flat sibling of its `rollout.json`; the manifest cannot name other paths. */
export function openBundledRollout(base: string, entry: RolloutIndexEntry, signal?: AbortSignal, fetcher: Fetch = fetch): Promise<RolloutBundle> {
  const read: RolloutReader = async (file, maxBytes) => {
    const bytes = await fetchBounded(`${base}simulated/${entry.id}/${file}`, maxBytes, signal, fetcher);
    if (!bytes) throw new Error(`Bundled rollout file could not load: ${entry.id}/${file}.`);
    return bytes;
  };
  return openRollout(read, 'bundled');
}
