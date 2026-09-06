// SPDX-License-Identifier: MIT
// Bounded mission planning and a fixed-command validation runner. No shell input.
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PACKAGE_VERSION = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')).version;
export const MAX_REPORT_BYTES = 48 * 1024;
const MAX_LOG_BYTES = 4 * 1024 * 1024;
const MAX_ARTIFACTS = 16;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const REQUIRED_ARTIFACTS = [
  'rulab/dist/index.html', 'rulab/dist/wasm/worldgraph_wasm.js', 'rulab/dist/wasm/worldgraph_wasm_bg.wasm',
  ...['capture.json', 'frame-000.splat', 'frame-001.splat', 'frame-002.splat', 'frame-003.splat'].map((name) => `rulab/dist/capture-example/${name}`),
];
export const GATES = Object.freeze([
  { id: 'harness-tests', cwd: '.', executable: 'node', args: ['--test', 'bin/harness.test.js'] },
  { id: 'rust-tests', cwd: '.', executable: 'cargo', args: ['test', '--workspace', '--all-features', '--locked'] },
  { id: 'wasm-build', cwd: 'rulab', executable: 'npm', args: ['run', 'build:wasm'] },
  { id: 'typecheck', cwd: 'rulab', executable: 'npm', args: ['run', 'typecheck'] },
  { id: 'unit-tests', cwd: 'rulab', executable: 'npm', args: ['test'] },
  { id: 'production-build', cwd: 'rulab', executable: 'npm', args: ['run', 'build'] },
  { id: 'browser-tests', cwd: 'rulab', executable: 'npm', args: ['run', 'test:e2e'] },
]);

const record = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const exactKeys = (v, required, optional = []) => record(v) && required.every((key) => Object.hasOwn(v, key)) && Object.keys(v).every((key) => [...required, ...optional].includes(key));
const bounded = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;
const sha256 = (v) => createHash('sha256').update(v).digest('hex');
export class InputError extends Error {}
function requireInput(condition, message) { if (!condition) throw new InputError(message); }
const commandOf = (g) => ({ executable: g.executable, args: [...g.args], cwd: g.cwd });

export function missionPlan(input) {
  requireInput(exactKeys(input, ['objective', 'scope', 'deployment']), 'Expected objective, scope, deployment only.');
  requireInput(bounded(input.objective, 4000), 'objective must contain 1 to 4000 characters.');
  requireInput(input.scope === 'rulab-4d', 'scope must be rulab-4d.');
  requireInput(['github-pages', 'none'].includes(input.deployment), 'Unsupported deployment.');
  return {
    version: 1, objective: input.objective, scope: input.scope, deployment: input.deployment,
    assumptions: ['RuLab reference images describe an authored concept, not a calibrated scan.', 'No GPU performance or learned dynamics claim without captured execution evidence.'],
    workstreams: [
      { id: 'scene', inputs: ['concept references', 'metre-based ENU frame'], outputs: ['Gaussian environment', 'independent camera motion', 'mesh interactions'], invariant: 'Authored geometry and observed assets retain distinct provenance.' },
      { id: 'timeline', inputs: ['stable entity IDs', 'ordered events'], outputs: ['deterministic replay', 'scenario state', 'WorldGraph WASM bridge'], invariant: 'Seeking to the same time and event history produces the same state.' },
      { id: 'delivery', inputs: ['source commit', 'fixed validation gates'], outputs: ['static GitHub Pages build', 'machine-readable evidence', 'reviewable change'], invariant: 'Skipped tests never count as passed; publication requires successful gates.' },
    ],
    acceptance: ['Translation reveals real parallax.', 'Replay at a selected time restores identical entity state.', 'A browser test confirms WebGL2 splat rendering and mesh coexistence.', 'GitHub Pages base path and mobile controls work.'],
    execution: 'This tool returns a plan. It does not spawn agents, run commands, or publish.',
  };
}

export function validationPlan(input) {
  requireInput(exactKeys(input, ['scope', 'includeBrowser']), 'Expected scope and includeBrowser only.');
  requireInput(input.scope === 'rulab-4d' && typeof input.includeBrowser === 'boolean', 'Invalid validation plan arguments.');
  return { version: 1, scope: input.scope, gates: GATES.map((gate) => ({ id: gate.id, command: commandOf(gate), required: true, enabled: gate.id !== 'browser-tests' || input.includeBrowser })),
    runner: ['node', 'bin/cli.js', 'rulab', 'verify', ...(input.includeBrowser ? [] : ['--without-browser'])],
    acceptance: 'Every required gate must pass. A disabled browser gate makes the report incomplete.',
    limitations: ['Browser correctness does not establish performance on physical mobile devices.', 'Procedural motion is not a trained predictive world model.'] };
}

export function validateEvidence(input) {
  requireInput(exactKeys(input, ['report']), 'Expected report only.');
  requireInput(Buffer.byteLength(JSON.stringify(input.report) ?? '') <= MAX_REPORT_BYTES, 'Report exceeds 48 KiB.');
  const report = input.report;
  requireInput(exactKeys(report, ['schemaVersion', 'scope', 'generatedAt', 'source', 'gates', 'artifacts', 'summary']), 'Unexpected report shape.');
  requireInput(report.schemaVersion === 1 && report.scope === 'rulab-4d', 'Unsupported evidence schema or scope.');
  requireInput(bounded(report.generatedAt, 40) && !Number.isNaN(Date.parse(report.generatedAt)), 'Invalid report timestamp.');
  requireInput(exactKeys(report.source, ['commit', 'dirty', 'packageVersion', 'location']), 'Invalid source provenance.');
  requireInput(/^(?:[a-f0-9]{40}|unknown)$/.test(report.source.commit) && typeof report.source.dirty === 'boolean' && bounded(report.source.packageVersion, 64) && ['checkout', 'installed-package'].includes(report.source.location), 'Invalid source metadata.');
  requireInput(Array.isArray(report.gates) && report.gates.length <= GATES.length, 'Too many gates.');
  requireInput(Array.isArray(report.artifacts) && report.artifacts.length <= MAX_ARTIFACTS, 'Too many artifacts.');
  requireInput(exactKeys(report.summary, ['passed', 'failed', 'skipped', 'complete']), 'Invalid summary.');
  const issues = [], seen = new Set();
  for (const gate of report.gates) {
    requireInput(exactKeys(gate, ['id', 'status', 'command', 'exitCode', 'durationMs', 'reason', 'log']), 'Invalid gate shape.');
    const expected = GATES.find((item) => item.id === gate.id);
    requireInput(expected && !seen.has(gate.id), 'Unknown or duplicate gate.');
    seen.add(gate.id);
    requireInput(['passed', 'failed', 'skipped'].includes(gate.status), 'Invalid gate status.');
    requireInput(exactKeys(gate.command, ['executable', 'args', 'cwd']) && gate.command.executable === expected.executable && gate.command.cwd === expected.cwd && Array.isArray(gate.command.args) && gate.command.args.length === expected.args.length && gate.command.args.every((arg, i) => arg === expected.args[i]), 'Gate command differs from the fixed validation plan.');
    requireInput(gate.exitCode === null || (Number.isInteger(gate.exitCode) && gate.exitCode >= 0 && gate.exitCode <= 255), 'Invalid process exit code.');
    requireInput(Number.isSafeInteger(gate.durationMs) && gate.durationMs >= 0 && gate.durationMs <= 86_400_000 && typeof gate.reason === 'string' && gate.reason.length <= 2000, 'Invalid duration or reason.');
    requireInput(gate.log === null || (exactKeys(gate.log, ['path', 'sha256', 'bytes', 'truncated']) && bounded(gate.log.path, 512) && /^[a-f0-9]{64}$/.test(gate.log.sha256) && Number.isSafeInteger(gate.log.bytes) && gate.log.bytes >= 0 && gate.log.bytes <= MAX_LOG_BYTES && typeof gate.log.truncated === 'boolean'), 'Invalid log metadata.');
    requireInput(gate.status !== 'passed' || (gate.exitCode === 0 && gate.log !== null), 'Passed gate requires exit 0 and log metadata.');
    requireInput(gate.status !== 'skipped' || (gate.exitCode === null && gate.log === null && gate.reason.length > 0), 'Skipped gate must have a reason and no execution evidence.');
    requireInput(gate.status !== 'failed' || gate.exitCode !== 0, 'Failed gate cannot have exit 0.');
    if (gate.status !== 'passed') issues.push(`${gate.id}: ${gate.status}${gate.reason ? ` (${gate.reason})` : ''}`);
  }
  const artifactPaths = new Set();
  for (const artifact of report.artifacts) {
    requireInput(exactKeys(artifact, ['path', 'sha256', 'bytes']) && bounded(artifact.path, 512) && /^[a-f0-9]{64}$/.test(artifact.sha256) && Number.isSafeInteger(artifact.bytes) && artifact.bytes > 0, 'Invalid artifact metadata.');
    requireInput(!artifactPaths.has(artifact.path), 'Duplicate artifact path.');
    artifactPaths.add(artifact.path);
  }
  for (const gate of GATES) if (!seen.has(gate.id)) issues.push(`${gate.id}: missing`);
  if (report.source.commit === 'unknown') issues.push('Source commit is unknown.');
  if (report.source.dirty) issues.push('Source checkout has uncommitted changes.');
  for (const path of REQUIRED_ARTIFACTS) if (!artifactPaths.has(path)) issues.push(`Required static artifact missing: ${path}.`);
  for (const extension of ['js', 'css']) if (![...artifactPaths].some((path) => new RegExp(`^rulab/dist/assets/[^/]+\\.${extension}$`).test(path))) issues.push(`Built ${extension.toUpperCase()} artifact missing.`);
  const counts = Object.fromEntries(['passed', 'failed', 'skipped'].map((state) => [state, report.gates.filter((g) => g.status === state).length]));
  const complete = GATES.every((g) => report.gates.some((r) => r.id === g.id && r.status === 'passed'));
  requireInput(['passed', 'failed', 'skipped'].every((key) => report.summary[key] === counts[key]) && report.summary.complete === complete, 'Summary disagrees with gate results.');
  return { structurallyValid: true, complete, issues, provenance: 'caller-reported', independentlyVerified: false,
    acceptance: complete && issues.length === 0 ? 'Reported gates are internally consistent. Verify artifact and log hashes against the cited CI run before accepting.' : 'Acceptance requirements are not fully evidenced.',
    warning: 'This tool validates structure and internal consistency only. Caller-provided exit codes, booleans, paths, and hashes do not prove execution.' };
}

const objectSchema = (properties, extra = {}) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties, ...extra });
const hashSchema = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const pathSchema = { type: 'string', minLength: 1, maxLength: 512 };
const logSchema = objectSchema({ path: pathSchema, sha256: hashSchema, bytes: { type: 'integer', minimum: 0, maximum: MAX_LOG_BYTES }, truncated: { type: 'boolean' } });
const artifactSchema = objectSchema({ path: pathSchema, sha256: hashSchema, bytes: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER } });
export const EVIDENCE_SCHEMA = objectSchema({
  schemaVersion: { const: 1 }, scope: { const: 'rulab-4d' },
  generatedAt: { type: 'string', format: 'date-time', maxLength: 40 },
  source: objectSchema({ commit: { type: 'string', pattern: '^(?:[a-f0-9]{40}|unknown)$' }, dirty: { type: 'boolean' }, packageVersion: { type: 'string', minLength: 1, maxLength: 64 }, location: { enum: ['checkout', 'installed-package'] } }),
  gates: { type: 'array', maxItems: GATES.length, items: objectSchema({
    id: { enum: GATES.map((g) => g.id) }, status: { enum: ['passed', 'failed', 'skipped'] },
    command: { oneOf: GATES.map((g) => objectSchema({ executable: { const: g.executable }, args: { const: g.args }, cwd: { const: g.cwd } })) },
    exitCode: { anyOf: [{ type: 'null' }, { type: 'integer', minimum: 0, maximum: 255 }] },
    durationMs: { type: 'integer', minimum: 0, maximum: 86_400_000 }, reason: { type: 'string', maxLength: 2000 }, log: { anyOf: [{ type: 'null' }, logSchema] },
  }) },
  artifacts: { type: 'array', maxItems: MAX_ARTIFACTS, items: artifactSchema },
  summary: objectSchema({ passed: { type: 'integer', minimum: 0, maximum: GATES.length }, failed: { type: 'integer', minimum: 0, maximum: GATES.length }, skipped: { type: 'integer', minimum: 0, maximum: GATES.length }, complete: { type: 'boolean' } }),
}, { description: 'schemaVersion 1 report from worldgraphs rulab verify. Maximum serialized size 48 KiB. Hashes and exit codes are caller-reported, not independently verified.' });

export const TOOLS = [
  { name: 'worldgraph_mission_plan', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, description: 'Create a bounded RuLab implementation mission with explicit inputs, outputs, and invariants. Does not execute actions.', inputSchema: { type: 'object', additionalProperties: false, required: ['objective', 'scope', 'deployment'], properties: { objective: { type: 'string', minLength: 1, maxLength: 4000 }, scope: { const: 'rulab-4d' }, deployment: { enum: ['github-pages', 'none'] } } } },
  { name: 'worldgraph_validation_plan', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, description: 'List fixed RuLab validation gates and commands; disabled required gates remain incomplete.', inputSchema: { type: 'object', additionalProperties: false, required: ['scope', 'includeBrowser'], properties: { scope: { const: 'rulab-4d' }, includeBrowser: { type: 'boolean' } } } },
  { name: 'worldgraph_evidence_validate', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, description: 'Validate reported evidence structure and consistency. Does not attest execution or trust caller-supplied success claims.', inputSchema: { type: 'object', additionalProperties: false, required: ['report'], properties: { report: EVIDENCE_SCHEMA } } },
];

export function callTool(name, args) {
  const handlers = { worldgraph_mission_plan: missionPlan, worldgraph_validation_plan: validationPlan, worldgraph_evidence_validate: validateEvidence };
  const normalized = name.startsWith('mcp__worldgraph__') ? name.slice('mcp__worldgraph__'.length) : name;
  requireInput(Object.hasOwn(handlers, normalized), 'Unknown tool.');
  return handlers[normalized](args);
}

function execute(command, cwd, timeoutMs = 900_000) {
  return new Promise((resolveResult) => {
    const started = Date.now();
    const chunks = []; let bytes = 0, truncated = false, timedOut = false, settled = false;
    const child = spawn(command.executable, command.args, { cwd, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const collect = (data) => { const remaining = MAX_LOG_BYTES - bytes; if (remaining <= 0) { truncated = true; return; } const part = data.subarray(0, remaining); chunks.push(part); bytes += part.length; if (part.length < data.length) truncated = true; };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    const finish = (result) => { if (settled) return; settled = true; clearTimeout(timer); resolveResult({ ...result, durationMs: Date.now() - started, output: Buffer.concat(chunks), truncated }); };
    const timer = setTimeout(() => {
      timedOut = true;
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* Process may have exited between timeout and kill. */ }
      finish({ exitCode: null, reason: `Validation timed out after ${Math.round(timeoutMs / 1000)} seconds.` });
    }, timeoutMs);
    child.on('error', (error) => finish({ exitCode: null, reason: `Process could not start: ${error.code ?? error.message}` }));
    child.on('close', (code, signal) => finish({ exitCode: code, reason: timedOut ? `Validation timed out after ${Math.round(timeoutMs / 1000)} seconds.` : signal ? `Process terminated by ${signal}.` : '' }));
  });
}

function locateCheckout(start) {
  let root = realpathSync(start);
  while (true) {
    if (existsSync(join(root, 'Cargo.toml')) && existsSync(join(root, 'worldgraph-wasm')) && existsSync(join(root, 'rulab', 'package.json'))) return root;
    const parent = dirname(root); if (parent === root) return null; root = parent;
  }
}

// Replace, rather than follow, an existing symlink and publish whole report/log files atomically.
function writeArtifact(path, bytes) {
  const temporary = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
  renameSync(temporary, path);
}

// Inspect only the small entrypoint and its direct local code/style references,
// plus the known dynamically loaded WASM pair and five bundled capture files.
// Never recursively walk dist or follow paths from an imported capture manifest.
function collectArtifacts(root) {
  const artifacts = [], issues = [], paths = new Set(REQUIRED_ARTIFACTS);
  const dist = join(root, 'rulab/dist');
  const readBounded = (path, limit) => {
    const file = join(root, path), real = realpathSync(file), within = relative(dist, real);
    requireInput(within && within !== '..' && !within.startsWith(`..${sep}`) && !isAbsolute(within), 'Artifact resolves outside the build directory.');
    const stat = statSync(file);
    requireInput(stat.isFile() && stat.size > 0 && stat.size <= limit, `Artifact must be a nonempty regular file of at most ${limit} bytes.`);
    return readFileSync(file);
  };
  try {
    const html = readBounded(REQUIRED_ARTIFACTS[0], 256 * 1024).toString('utf8');
    const base = new URL(process.env.WORLDGRAPH_BASE_PATH || '/worldgraph/', 'https://worldgraph.invalid/');
    requireInput(base.origin === 'https://worldgraph.invalid' && base.pathname.endsWith('/'), 'Build base must be a local directory.');
    let tags = 0;
    for (const match of html.matchAll(/<(?:script|link)\b[^>]*>/gi)) {
      requireInput(++tags <= 64, 'Entrypoint exceeds 64 script/link tags.');
      const reference = /\b(?:src|href)\s*=\s*(["'])(.*?)\1/i.exec(match[0])?.[2];
      if (!reference) continue;
      const url = new URL(reference, base);
      if (!/\.(?:m?js|css|wasm)$/i.test(url.pathname)) continue;
      requireInput(url.origin === base.origin && url.pathname.startsWith(base.pathname), 'Code/style reference is outside the local build base.');
      const local = decodeURIComponent(url.pathname.slice(base.pathname.length));
      requireInput(local && !local.includes('\\') && !local.split('/').some((part) => part === '..' || part === '.' || part === '') && !local.includes('\0'), 'Unsafe artifact reference.');
      const path = `rulab/dist/${local}`;
      requireInput(path.length <= 512, 'Artifact path exceeds 512 characters.');
      requireInput(paths.has(path) || paths.size < MAX_ARTIFACTS, `Build exceeds ${MAX_ARTIFACTS} evidence artifacts.`);
      paths.add(path);
    }
  } catch (error) { issues.push(`Entrypoint artifact inspection failed: ${error.message}`); }
  for (const path of [...paths].sort()) {
    try {
      const content = readBounded(path, MAX_ARTIFACT_BYTES);
      artifacts.push({ path, sha256: sha256(content), bytes: content.length });
    } catch (error) { issues.push(`Artifact unavailable: ${path} (${error.message})`); }
  }
  return { artifacts, issues };
}

export async function verifyRuLab(argv, options = {}) {
  let includeBrowser = true, reportPath = '.artifacts/rulab/evidence.json';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--without-browser') includeBrowser = false;
    else if (argv[i] === '--report' && argv[i + 1]) reportPath = argv[++i];
    else throw new InputError(`Unknown or incomplete option: ${argv[i]}`);
  }
  const root = locateCheckout(options.cwd ?? process.cwd());
  if (!root) throw new InputError('RuLab verification requires a WorldGraph source checkout containing Cargo.toml and rulab/package.json. Installed npm packages provide MCP planning but do not include the Rust/browser workspace.');
  const target = resolve(root, reportPath), targetRelative = relative(root, target);
  requireInput(targetRelative && !targetRelative.startsWith(`..${sep}`) && targetRelative !== '..' && !isAbsolute(targetRelative) && target.endsWith('.json'), 'Report must be a JSON file inside the source checkout.');
  // Refuse symlinked output ancestors: a local report cannot escape its checkout.
  let ancestor = dirname(target); while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  requireInput(realpathSync(ancestor) === ancestor, 'Report directory must not resolve through symlinks.');
  const outputDir = dirname(target); mkdirSync(outputDir, { recursive: true });
  const commitResult = await execute({ executable: 'git', args: ['rev-parse', '--verify', 'HEAD'] }, root, 10_000);
  const statusResult = await execute({ executable: 'git', args: ['status', '--porcelain', '--untracked-files=normal'] }, root, 10_000);
  const commit = commitResult.output.toString('utf8').trim();
  const report = { schemaVersion: 1, scope: 'rulab-4d', generatedAt: new Date().toISOString(), source: { commit: /^[a-f0-9]{40}$/.test(commit) ? commit : 'unknown', dirty: statusResult.exitCode !== 0 || statusResult.output.length > 0, packageVersion: PACKAGE_VERSION, location: 'checkout' }, gates: [], artifacts: [], summary: {} };
  const runProcess = options.execute ?? execute;
  for (const gate of GATES) {
    const result = { id: gate.id, status: 'skipped', command: commandOf(gate), exitCode: null, durationMs: 0, reason: '', log: null };
    if (!includeBrowser && gate.id === 'browser-tests') result.reason = 'Browser validation disabled explicitly; physical GPU performance remains unverified.';
    else {
      process.stderr.write(`RuLab validation: ${gate.id}\n`);
      const execution = await runProcess(commandOf(gate), resolve(root, gate.cwd));
      const logFile = join(outputDir, `${gate.id}.log`);
      writeArtifact(logFile, execution.output);
      Object.assign(result, { status: execution.exitCode === 0 ? 'passed' : 'failed', exitCode: execution.exitCode, durationMs: execution.durationMs, reason: execution.reason,
        log: { path: relative(root, logFile).split(sep).join('/'), sha256: sha256(execution.output), bytes: execution.output.length, truncated: execution.truncated } });
    }
    report.gates.push(result);
  }
  const collected = collectArtifacts(root);
  report.artifacts = collected.artifacts;
  const counts = Object.fromEntries(['passed', 'failed', 'skipped'].map((state) => [state, report.gates.filter((g) => g.status === state).length]));
  report.summary = { ...counts, complete: report.gates.every((g) => g.status === 'passed') };
  const validation = validateEvidence({ report });
  const issues = [...validation.issues, ...collected.issues];
  const accepted = report.summary.complete && issues.length === 0;
  writeArtifact(target, `${JSON.stringify(report, null, 2)}\n`);
  if (!accepted) process.stderr.write(`RuLab acceptance rejected:\n${issues.map((issue) => `- ${issue}`).join('\n')}\n`);
  process.stdout.write(`${JSON.stringify({ report: targetRelative.split(sep).join('/'), ...report.summary, accepted, issues })}\n`);
  return accepted ? 0 : 1;
}
