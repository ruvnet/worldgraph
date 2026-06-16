# worldgraph

AI coding agent for building digital twins with worldgraph — architect, implement, review, and test the Rust spatial/sensor-graph crates

> Advanced Coding harness · domain: `software-engineering`. Generated with [create-agent-harness](https://github.com/ruvnet/agent-harness-generator).

## Behavioral rules

- Use the harness's MCP tools (`mcp__worldgraph__*`) for orchestration
- Memory and routing are handled by the kernel — you don't need to learn them
- Defer destructive operations to the user

## Agents

| Agent | Tier | Role |
|---|---|---|
| `architect` | opus | Designs the change before code is written. |
| `implementer` | sonnet | Writes code that matches the surrounding style. |
| `reviewer` | opus | Hunts correctness bugs in the diff. |
| `test-writer` | sonnet | Adds the missing tests for the change. |
## Skills

- `/plan-change` — Turn a feature request into a minimal, file-level implementation plan before any code.

## Commands

- `doctor` — Health-check the harness: kernel load, MCP wiring, memory backend, host adapter.
- `review-diff` — Review the current working diff for correctness, security, and reuse.

## Architecture

This harness uses [@metaharness/kernel](https://www.npmjs.com/package/@metaharness/kernel) — a Rust-compiled WASM module with a NAPI-RS native fallback — so the same code runs identically on every platform.
