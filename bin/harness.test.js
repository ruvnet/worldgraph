// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { createDispatcher, MAX_MESSAGE_BYTES, startMcp } from './mcp-server.js';
import { callTool, GATES, InputError, missionPlan, PACKAGE_ROOT, PACKAGE_VERSION, validateEvidence, validationPlan, verifyRuLab } from './rulab-harness.js';

const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } };
const ready = () => { const dispatch = createDispatcher(); assert.equal(dispatch(initialize).result.serverInfo.name, 'worldgraph'); return dispatch; };
const toolRequest = (name, args) => ({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } });
const planArgs = { objective: 'Build replayable RuLab', scope: 'rulab-4d', deployment: 'github-pages' };
const commandOf = (g) => ({ executable: g.executable, args: [...g.args], cwd: g.cwd });
function reportFixture() {
  return { schemaVersion: 1, scope: 'rulab-4d', generatedAt: '2026-09-06T20:00:00.000Z', source: { commit: 'a'.repeat(40), dirty: false, packageVersion: PACKAGE_VERSION, location: 'checkout' },
    gates: GATES.map((g) => ({ id: g.id, status: 'passed', command: commandOf(g), exitCode: 0, durationMs: 123, reason: '', log: { path: `.artifacts/rulab/${g.id}.log`, sha256: 'b'.repeat(64), bytes: 30, truncated: false } })),
    artifacts: [{ path: 'rulab/dist/index.html', sha256: 'c'.repeat(64), bytes: 1000 }], summary: { passed: GATES.length, failed: 0, skipped: 0, complete: true } };
}
async function transport(chunks) {
  const output = new PassThrough(); let text = '';
  output.on('data', (data) => { text += data.toString(); });
  await startMcp(Readable.from(chunks), output);
  return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('initialization negotiates protocol and reports actual package version without loading adapters', () => {
  const dispatch = createDispatcher(), result = dispatch(initialize).result;
  assert.equal(result.protocolVersion, '2025-06-18');
  assert.equal(result.serverInfo.version, PACKAGE_VERSION);
  assert.deepEqual(result.capabilities, { tools: { listChanged: false } });
  assert.equal(dispatch(initialize).error.code, -32600);
});
test('initialization fallback, validation and order are explicit', () => {
  const dispatch = createDispatcher();
  assert.equal(dispatch({ jsonrpc: '2.0', id: 2, method: 'tools/list' }).error.code, -32002);
  assert.equal(dispatch({ ...initialize, params: {} }).error.code, -32602);
  assert.equal(dispatch({ ...initialize, params: { ...initialize.params, protocolVersion: 'unknown' } }).result.protocolVersion, '2025-06-18');
});
test('tool list exposes three bounded tools and prefixed client names resolve', () => {
  const dispatch = ready(), list = dispatch({ jsonrpc: '2.0', id: 3, method: 'tools/list' }).result.tools;
  assert.deepEqual(list.map((t) => t.name), ['worldgraph_mission_plan', 'worldgraph_validation_plan', 'worldgraph_evidence_validate']);
  assert.ok(list.every((t) => t.inputSchema.additionalProperties === false));
  assert.deepEqual(callTool('mcp__worldgraph__worldgraph_mission_plan', planArgs), missionPlan(planArgs));
});
test('unknown methods and malformed JSON-RPC envelopes produce protocol errors', () => {
  const dispatch = ready();
  assert.equal(dispatch({ jsonrpc: '2.0', id: 2, method: 'not-a-method' }).error.code, -32601);
  for (const input of [null, [], 'text', { jsonrpc: '2.0', id: null, method: 'ping' }, { jsonrpc: '2.0', id: {}, method: 'ping' }, { jsonrpc: '2.0', id: 4, method: 'ping', params: [] }, { jsonrpc: '2.0', id: 4, method: 'ping', extra: true }]) assert.equal(dispatch(input).error.code, -32600);
  assert.equal(dispatch({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal(dispatch({ jsonrpc: '2.0', method: 'unknown-notification' }), null);
});
test('tool mistakes are tool errors and never execute caller-supplied commands', () => {
  const dispatch = ready();
  for (const request of [toolRequest('unknown', {}), toolRequest('worldgraph_mission_plan', { ...planArgs, command: 'touch /tmp/unwanted' }), toolRequest('worldgraph_mission_plan', { ...planArgs, objective: 'x'.repeat(4001) }), toolRequest('worldgraph_validation_plan', { scope: 'rulab-4d', includeBrowser: 'true' })]) {
    const result = dispatch(request).result;
    assert.equal(result.isError, true);
    assert.equal(result.content[0].type, 'text');
  }
  assert.equal(dispatch({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'worldgraph_mission_plan' } }).error.code, -32602);
});
test('bounded transport survives parse errors, UTF-8 errors and oversized input, then handles valid messages', async () => {
  const results = await transport([Buffer.from('{malformed}\n'), Buffer.from([0xff, 10]), Buffer.from(`${'x'.repeat(MAX_MESSAGE_BYTES + 1)}\n`), Buffer.from(`${JSON.stringify(initialize)}\n`)]);
  assert.deepEqual(results.slice(0, 3).map((r) => r.error.code), [-32700, -32700, -32600]);
  assert.equal(results[3].id, 1);
  assert.equal(results.length, 4);
});
test('chunk boundaries, CRLF, UTF-8 split boundaries and EOF messages work', async () => {
  const message = Buffer.from(`${JSON.stringify(initialize)}\r\n${JSON.stringify(toolRequest('worldgraph_mission_plan', { ...planArgs, objective: 'RuLab 世界' }))}`);
  const results = await transport(Array.from(message, (byte) => Buffer.from([byte])));
  assert.equal(results.length, 2);
  assert.equal(results[1].result.structuredContent.objective, 'RuLab 世界');
});
test('oversized unterminated lines produce one error and notification floods produce no replies', async () => {
  const results = await transport(['x'.repeat(MAX_MESSAGE_BYTES), 'x', 'x'.repeat(MAX_MESSAGE_BYTES), '\n', `${JSON.stringify(initialize)}\n`, ...Array(10).fill('{"jsonrpc":"2.0","method":"notifications/initialized"}\n')]);
  assert.equal(results.length, 2);
  assert.equal(results[0].error.code, -32600);
});
test('validation plan never converts a disabled browser test to a passing gate', () => {
  const plan = validationPlan({ scope: 'rulab-4d', includeBrowser: false });
  const browser = plan.gates.find((g) => g.id === 'browser-tests');
  assert.equal(browser.required, true); assert.equal(browser.enabled, false);
  assert.ok(plan.runner.includes('--without-browser'));
  assert.ok(plan.gates.every((g) => !Object.hasOwn(g.command, 'shell')));
});
test('apparently passing evidence is explicitly caller-reported and not execution proof', () => {
  const result = validateEvidence({ report: reportFixture() });
  assert.equal(result.complete, true); assert.equal(result.independentlyVerified, false);
  assert.equal(result.provenance, 'caller-reported');
  assert.match(result.warning, /do not prove execution/);
});
test('evidence rejects booleans, forged summaries, mismatched commands and missing log metadata', () => {
  assert.throws(() => validateEvidence({ report: true }), InputError);
  for (const mutate of [r => { r.summary.complete = false; }, r => { r.gates[0].command.args = ['-e', 'process.exit(0)']; }, r => { r.gates[0].log = null; }, r => { r.gates[0].exitCode = 1; }, r => { r.gates.push(r.gates[0]); }, r => { r.artifacts[0].sha256 = 'invalid'; }]) {
    const report = reportFixture(); mutate(report); assert.throws(() => validateEvidence({ report }), InputError);
  }
});
test('missing and skipped gates remain incomplete and dirty source remains visible', () => {
  const report = reportFixture(); report.gates.pop(); report.summary = { passed: GATES.length - 1, failed: 0, skipped: 0, complete: false }; report.source.dirty = true;
  const result = validateEvidence({ report }); assert.equal(result.complete, false); assert.ok(result.issues.includes('browser-tests: missing')); assert.ok(result.issues.some((s) => s.includes('uncommitted')));
  const skipped = reportFixture(); Object.assign(skipped.gates.at(-1), { status: 'skipped', exitCode: null, log: null, reason: 'Browser unavailable' }); skipped.summary = { passed: GATES.length - 1, failed: 0, skipped: 1, complete: false };
  assert.equal(validateEvidence({ report: skipped }).complete, false);
});
test('evidence payload and nested unrecognized fields are bounded', () => {
  const report = reportFixture(); report.gates[0].reason = 'x'.repeat(50_000);
  assert.throws(() => validateEvidence({ report }), /48 KiB/);
  const extra = reportFixture(); extra.source.secret = true;
  assert.throws(() => validateEvidence({ report: extra }), /provenance/);
});
test('real CLI stdio produces only protocol JSON and package version is independent of kernel', () => {
  const child = spawnSync(process.execPath, ['bin/cli.js', 'mcp', 'start'], { cwd: PACKAGE_ROOT, input: `${JSON.stringify(initialize)}\n${JSON.stringify(toolRequest('worldgraph_validation_plan', { scope: 'rulab-4d', includeBrowser: true }))}\n`, encoding: 'utf8', timeout: 10_000 });
  assert.equal(child.status, 0, child.stderr); assert.equal(child.stderr, '');
  const output = child.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(output.length, 2); assert.equal(output[1].result.structuredContent.gates.length, GATES.length);
  const version = spawnSync(process.execPath, ['bin/cli.js', '--version'], { cwd: PACKAGE_ROOT, encoding: 'utf8' });
  assert.equal(version.stdout.trim(), PACKAGE_VERSION);
});
test('verification refuses installed packages and arbitrary command options', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'worldgraph-installed-'));
  try {
    await assert.rejects(verifyRuLab([], { cwd: directory }), /requires a WorldGraph source checkout/);
    await assert.rejects(verifyRuLab(['--shell', 'echo injected'], { cwd: directory }), /Unknown or incomplete option/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('fixed runner writes hashed logs, preserves failed/skipped gates and rejects path escape', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'worldgraph-verify-'));
  mkdirSync(join(directory, 'worldgraph-wasm')); mkdirSync(join(directory, 'rulab', 'dist'), { recursive: true });
  writeFileSync(join(directory, 'Cargo.toml'), '[workspace]\n'); writeFileSync(join(directory, 'rulab', 'package.json'), '{}'); writeFileSync(join(directory, 'rulab', 'dist', 'index.html'), '<title>RuLab</title>');
  const calls = [];
  try {
    await assert.rejects(verifyRuLab(['--report', '../outside.json'], { cwd: directory }), /inside the source checkout/);
    const code = await verifyRuLab(['--without-browser'], { cwd: directory, execute: async (command) => { calls.push(command); return { exitCode: command.executable === 'cargo' ? 1 : 0, durationMs: 1, reason: '', output: Buffer.from('actual captured output'), truncated: false }; } });
    assert.equal(code, 1); assert.equal(calls.length, GATES.length - 1);
    const report = JSON.parse(readFileSync(join(directory, '.artifacts/rulab/evidence.json'), 'utf8'));
    assert.equal(report.summary.failed, 1); assert.equal(report.summary.skipped, 1); assert.equal(report.summary.complete, false);
    assert.equal(report.gates.find((g) => g.id === 'rust-tests').status, 'failed');
    assert.equal(report.gates.at(-1).log, null); assert.equal(report.gates[0].log.sha256.length, 64);
    assert.deepEqual(calls, GATES.slice(0, -1).map(commandOf));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('evidence command validation is independent of JSON property insertion order', () => {
  const report = reportFixture();
  const command = report.gates[0].command;
  report.gates[0].command = { cwd: command.cwd, args: command.args, executable: command.executable };
  assert.equal(validateEvidence({ report }).structurallyValid, true);
});
test('report output refuses symlinked directories and replaces file symlinks without following them', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'worldgraph-symlink-'));
  const outside = mkdtempSync(join(tmpdir(), 'worldgraph-outside-'));
  mkdirSync(join(directory, 'worldgraph-wasm')); mkdirSync(join(directory, 'rulab', 'dist'), { recursive: true });
  writeFileSync(join(directory, 'Cargo.toml'), '[workspace]\n'); writeFileSync(join(directory, 'rulab', 'package.json'), '{}');
  mkdirSync(join(directory, '.artifacts', 'rulab'), { recursive: true });
  writeFileSync(join(outside, 'protected.json'), '{"unchanged":true}');
  symlinkSync(outside, join(directory, 'outside'), 'dir');
  symlinkSync(join(outside, 'protected.json'), join(directory, '.artifacts/rulab/evidence.json'));
  symlinkSync(join(outside, 'protected.json'), join(directory, '.artifacts/rulab/harness-tests.log'));
  try {
    await assert.rejects(verifyRuLab(['--report', 'outside/evidence.json'], { cwd: directory }), /symlinks/);
    await verifyRuLab(['--without-browser'], { cwd: directory, execute: async () => ({ exitCode: 1, durationMs: 0, reason: '', output: Buffer.from('failed'), truncated: false }) });
    assert.equal(readFileSync(join(outside, 'protected.json'), 'utf8'), '{"unchanged":true}');
    assert.equal(JSON.parse(readFileSync(join(directory, '.artifacts/rulab/evidence.json'), 'utf8')).summary.complete, false);
  } finally { rmSync(directory, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});
