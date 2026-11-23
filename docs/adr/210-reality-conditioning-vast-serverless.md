# ADR 210: Governed Reality conditioning and Vast Serverless render client

Status: Proposed, review branch only. No production activation.
Date: 2026-11-22
Owners: WorldGraph, RuView, RuLab, Cognitum Spaces and GPU serving lane.
Depends on WorldGraph ADR 204 and 208, Cognitum API ADR 107, and core-memory PR 243 and issue 242.

## Context

PAN2 currently produces real offline simulated video, but three recorded 20 second H200 runs took 2361 to 2401 seconds including model load. This is not real time generation. The authoritative WorldGraph state and verified Spaces snapshots are distinct from generated frames. RF count alone does not reveal textures, colors or metric person positions.

Vast Serverless manages endpoints, worker groups and autoscaled PyWorkers. A custom video model server must run alongside the worker. An LLM template does not produce world-model video. The ruOS secret vault has a named VAST_API_KEY, but the key is not injected into this isolated build host. No live serverless endpoint or spend approval was verified.

## Decision

1. Add a Rust conditioning module to wifi-densepose-worldmodel. Input binds tenant, workspace, site, space, calibration, privacy epoch, stream epoch, source snapshot hash, capture times, region evidence and explicit hosting approval to separately resolved Authority. It produces a versioned read-only manifest and SHA256 receipt.
2. Reject foreign scope, synthetic current frames, malformed hashes, expired sources, changed calibration, revoked privacy and unapproved hosting. Never derive coordinates from count-only evidence. Remove expired coordinates and do not portray predicted positions as current.
3. Keep all generated media separately labelled as simulated. Model processes must not have graph mutation credentials. Media returns a descriptor with exact source and manifest hashes and media SHA256, bytes and type. A matching hash proves lineage, not physical correctness.
4. The Python Vast client uses the officially documented Serverless get_endpoint and request path, calls only an EXISTING explicitly enabled custom endpoint at /v1/reality/render, and accepts only descriptor metadata. It verifies the Rust manifest digest and source expiry before and after the request.
5. The GPU video worker is a separate lane. This change does not deploy a model, a worker group, a model image or a billing resource, and it does not claim any real-time neural frame rate.
6. Cognitum Spaces remains a semantic sync system. Raw CSI, RF tensors, recordings and biometric data are not sent to remote GPUs. Hosted processing approval requires a verified allowed data projection and a documented processor decision. No cross-tenant shortcut is permitted.

## Vast deployment gate

Vast Serverless endpoints have scaling defaults that may maintain warm workers. Before creating or modifying an endpoint, obtain verified account rights, deposited balance, GPU availability, price, supported custom worker template, pinned image digest and model/weight license. Choose an explicitly reviewed one worker canary with min_load=0, min_cold_load=0, cold_workers=0, max_workers=1, bounded queues and a stop condition. This is a proposed configuration, NOT deployed state. Cold start cannot meet a 500 ms live SLA. A production low latency offering needs separately priced warm capacity.

The operator must authorize GPU allocation and data location before use. No training, downloads, production writes or IAM changes occur under this ADR alone.

## Test gates

Measured on a declared fast sensor profile, proposed unmeasured targets are deterministic capture to presentation P95 at most 150 ms, and neural conditioning age P95 at most 500 ms, 512 by 512, and 15 distinct generated valid FPS. All GPU timings include queue, encode, decode, VAE and display. A current region expires at its own evidence horizon regardless of aggregate P95. A hash is not a geometry metric.

Before neural admission, validate projected entity positions and masks against independent ground truth, and test: count only, blackout, wrong calibration, privacy revocation, foreign tenant, stale queued completion, mismatched media receipts and repeated frames. A failed neural gate leaves the deterministic view available.

## Implementation receipt

The source branch adds Rust contract tests for authority, evidence expiry, source lineage and count-only uncertainty; Python SDK tests use fakes only. One Rust example emits a manifest whose digest is independently accepted by the Python validator. Test counts and source revision appear in the PR. No live inference or photorealistic video generated.

## Rollback

Disable the remote client, cancel pending requests and clear temporary projection caches. Observed graph data remains unaffected and the separate RuLab deterministic view continues.

## Open work

RuView: calibrated consented camera/depth/RF replay fixture with clocks and ground truth.
WorldGraph: bind the source only to a real verified Spaces snapshot and authorized TwinEnvelope, not caller-provided hashes.
RuLab: current evidence, simulated media overlay and actual sensor-to-presentation instrumentation.
Vast GPU lane: custom PyWorker, pinned model backend, image license and performance receipt after approval.
Security: worker ingress, tenant isolation, privacy epoch, object erasure, cache expiry, media locator/SSRF and model provenance.
Cognitum Spaces: continue its separately reviewed organization sharing gates, without backfill or deployment from this lane.

## Acceptance

A populated authorized snapshot must compile into a bound manifest. A generated MP4 must refer to that exact manifest and source, and the verified media digest must match its bytes. A privacy change or stale completion must reject the frame. Generated media never becomes an observed person or event.

## Primary sources

Vast: https://github.com/vast-ai/docs and https://github.com/vast-ai/pyworker
Vast API: https://vast.ai/developers/api
Vast SDK: https://cloud.vast.ai/cli/
WorldGraph ADR 204: https://github.com/ruvnet/worldgraph/blob/main/docs/adr/ADR-204-rust-generative-world-model-runtime.md
PAN2 evidence: https://github.com/ruvnet/worldgraph/blob/main/docs/mission/pan2-rollout-evidence.md
Cognitum Spaces ADR 107: https://github.com/cognitum-one/api/blob/main/docs/adr/ADR-107-spaces-placement-physics-simulations-snapshots.md
