#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// WorldGraph harness CLI. Published npm package: worldgraphs; both bin aliases work.

import { PACKAGE_VERSION, verifyRuLab } from './rulab-harness.js';
import { startMcp } from './mcp-server.js';

async function loadHost() {
  const [{ loadKernel }, { default: adapter }] = await Promise.all([
    import('@metaharness/kernel'), import('@metaharness/host-claude-code'),
  ]);
  return { kernel: await loadKernel(), adapter };
}

const HARNESS_NAME = 'worldgraph';

/** `worldgraph init` — boot the kernel + host adapter and report status. */
async function init() {
  const { kernel, adapter } = await loadHost();
  const info = kernel.kernelInfo();
  console.log(`${HARNESS_NAME} — kernel ${info.version} (${kernel.backend})`);
  console.log(`Host adapter: ${adapter.name}`);
  console.log(`Run \`${HARNESS_NAME} doctor\` to verify the install.`);
  return 0;
}

/** `worldgraph doctor` — verify the install end-to-end (kernel + host resolve). */
async function doctor() {
  const { kernel, adapter } = await loadHost();
  const info = kernel.kernelInfo();
  const checks = [
    ['kernel loads', !!kernel],
    ['kernel reports a version', typeof info.version === 'string' && info.version.length > 0],
    ['kernel backend is native|wasm|js', ['native', 'wasm', 'js'].includes(kernel.backend)],
    ['host adapter has a name', typeof adapter?.name === 'string' && adapter.name.length > 0],
  ];
  let ok = true;
  for (const [label, pass] of checks) {
    console.log(`${pass ? 'PASS' : 'FAIL'} ${label}`);
    if (!pass) ok = false;
  }
  console.log(
    ok
      ? `\n${HARNESS_NAME}: all checks passed (kernel ${info.version}, ${kernel.backend} backend, host ${adapter.name})`
      : `\n${HARNESS_NAME}: doctor found problems`,
  );
  return ok ? 0 : 1;
}

/**
 * Dispatch one CLI invocation. Exported (not just run on import) so a test can
 * drive it without spawning a subprocess. Returns the intended exit code.
 */
export async function run(argv) {
  const cmd = argv[0] ?? 'init';
  switch (cmd) {
    case 'init':
      return init();
    case 'doctor':
      return doctor();
    case 'mcp':
      if (argv.length !== 2 || argv[1] !== 'start') return 2;
      await startMcp();
      return 0;
    case 'rulab':
      if (argv[1] !== 'verify') return 2;
      return verifyRuLab(argv.slice(2));
    case '--version':
    case '-v': {
      console.log(PACKAGE_VERSION);
      return 0;
    }
    case '--help':
    case '-h':
      console.log(`Usage: ${HARNESS_NAME} <command>\n\n  init     boot the kernel + host adapter (default)\n  doctor   verify the install end-to-end\n  mcp start  run bounded MCP tools over stdio\n  rulab verify [--without-browser] [--report path.json]\n             run fixed gates in a source checkout\n  --version  print the worldgraphs package version`);
      return 0;
    default:
      console.error(`Unknown command: ${cmd}. Try \`${HARNESS_NAME} --help\`.`);
      return 2;
  }
}

// CLI guard: execute only when invoked directly (not when imported by a test).
// npm's bin shims pass a NON-normalized argv[1] (e.g. ".../.bin/../<pkg>/bin/cli.js"
// on Windows) and may differ in case, so realpath BOTH sides before comparing —
// a naive string === misses the npx/shim path and the CLI silently no-ops.
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { argv } from 'node:process';
const invokedDirectly = (() => {
  if (!argv[1]) return false;
  try {
    const a = realpathSync(argv[1]);
    const b = realpathSync(fileURLToPath(import.meta.url));
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  run(argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
