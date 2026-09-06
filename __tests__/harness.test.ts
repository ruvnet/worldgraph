// SPDX-License-Identifier: MIT
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('passes the standalone bounded MCP and validation runner regression suite', () => {
  const result = spawnSync(process.execPath, ['--test', 'bin/harness.test.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', timeout: 30_000,
  });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 35_000);
