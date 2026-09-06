// SPDX-License-Identifier: MIT
// MCP stdio transport: one JSON-RPC message per line, bounded input and output.
import { TextDecoder } from 'node:util';
import { callTool, InputError, PACKAGE_VERSION, TOOLS } from './rulab-harness.js';

export const MAX_MESSAGE_BYTES = 64 * 1024;
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const hasId = (v) => isRecord(v) && Object.hasOwn(v, 'id');
const validId = (id) => (typeof id === 'string' && id.length <= 256) || (typeof id === 'number' && Number.isSafeInteger(id));
const failure = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

export function createDispatcher() {
  let initialized = false;
  return (request) => {
    const id = hasId(request) && validId(request.id) ? request.id : null;
    if (!isRecord(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string' || request.method.length > 128 || (hasId(request) && !validId(request.id)) || (Object.hasOwn(request, 'params') && !isRecord(request.params)) || Object.keys(request).some((key) => !['jsonrpc', 'id', 'method', 'params'].includes(key))) return failure(id, -32600, 'Invalid Request');
    // Notifications never receive responses, including unknown notifications.
    if (!hasId(request)) return null;
    if (request.method === 'initialize') {
      const p = request.params;
      if (initialized) return failure(id, -32600, 'Already initialized');
      if (!isRecord(p) || typeof p.protocolVersion !== 'string' || !isRecord(p.capabilities) || !isRecord(p.clientInfo) || typeof p.clientInfo.name !== 'string' || p.clientInfo.name.length > 256 || typeof p.clientInfo.version !== 'string' || p.clientInfo.version.length > 64) return failure(id, -32602, 'Invalid initialize parameters');
      initialized = true;
      return { jsonrpc: '2.0', id, result: { protocolVersion: PROTOCOLS.includes(p.protocolVersion) ? p.protocolVersion : PROTOCOLS[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'worldgraph', version: PACKAGE_VERSION }, instructions: 'Planning and evidence consistency only. No tool executes shell commands, spawns agents, changes files, or deploys. Run worldgraphs rulab verify separately for local validation.' } };
    }
    if (request.method === 'ping') return { jsonrpc: '2.0', id, result: {} };
    if (!initialized) return failure(id, -32002, 'Server not initialized');
    if (request.method === 'tools/list') {
      if (request.params && Object.keys(request.params).length) return failure(id, -32602, 'This server does not paginate tools.');
      return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
    }
    if (request.method === 'tools/call') {
      const p = request.params;
      if (!isRecord(p) || typeof p.name !== 'string' || !isRecord(p.arguments) || Object.keys(p).some((key) => !['name', 'arguments'].includes(key))) return failure(id, -32602, 'Expected tool name and arguments.');
      try {
        const result = callTool(p.name, p.arguments);
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: false } };
      } catch (error) {
        if (!(error instanceof InputError)) return failure(id, -32603, 'Internal error');
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: error.message }], isError: true } };
      }
    }
    return failure(id, -32601, 'Method not found');
  };
}

export async function startMcp(input = process.stdin, output = process.stdout) {
  const dispatch = createDispatcher();
  let buffered = Buffer.alloc(0), dropping = false;
  const send = async (message) => {
    if (message === null) return;
    const body = `${JSON.stringify(message)}\n`;
    if (!output.write(body)) await new Promise((resolve, reject) => {
      const clean = () => { output.off('drain', drained); output.off('error', errored); };
      const drained = () => { clean(); resolve(); };
      const errored = (error) => { clean(); reject(error); };
      output.once('drain', drained); output.once('error', errored);
    });
  };
  const consume = async (line) => {
    if (line.length === 0) return;
    try { await send(dispatch(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)))); }
    catch { await send(failure(null, -32700, 'Parse error')); }
  };
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    while (offset < bytes.length) {
      const newline = bytes.indexOf(10, offset), end = newline === -1 ? bytes.length : newline;
      const section = bytes.subarray(offset, end);
      if (!dropping) {
        if (buffered.length + section.length > MAX_MESSAGE_BYTES) { buffered = Buffer.alloc(0); dropping = true; await send(failure(null, -32600, 'Message exceeds 64 KiB')); }
        else buffered = Buffer.concat([buffered, section]);
      }
      if (newline !== -1) { if (!dropping) await consume(buffered); buffered = Buffer.alloc(0); dropping = false; }
      offset = newline === -1 ? bytes.length : newline + 1;
    }
  }
  if (buffered.length && !dropping) await consume(buffered);
}
