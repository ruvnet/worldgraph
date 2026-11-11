import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openRollout, parseRolloutIndexText, verifyRollout } from './manifest';

// Every rollout shipped in public/simulated must open and verify with the
// same code the browser uses. This is the contract check between the Rust
// bundle writer (worldgraph-pan2) and the viewer.
const root = resolve(__dirname, '../../public/simulated');

describe('bundled rollouts', async () => {
  const entries = parseRolloutIndexText(await readFile(resolve(root, 'index.json'), 'utf8'));
  it('lists the real PAN 2 rollouts', () => {
    expect(entries.map((entry) => entry.id)).toEqual(expect.arrayContaining(['pan2-rf-door', 'pan2-rover-aisle']));
  });
  for (const entry of entries) {
    it(`${entry.id} verifies byte for byte`, async () => {
      const dir = resolve(root, entry.id);
      const bundle = await openRollout(async (file) => {
        const bytes = await readFile(resolve(dir, file));
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      }, 'bundled');
      const verified = await verifyRollout(bundle);
      expect(verified).toBeTruthy();
      expect(bundle.manifest.simulated).toBe(true);
    });
  }
});
