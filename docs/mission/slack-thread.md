# Development thread drafts

Status: not sent. Slack is installed but no callable messaging capability was exposed in this session. These drafts must not be represented as posted messages.

## Parent

Implementing RuLab 4D in WorldGraph. Tracking: https://github.com/ruvnet/worldgraph/issues/6 . Scope: actual Gaussian rendering, independently movable camera, deterministic replay, Rust WASM graph and a reproducible Pages validation harness.

## Rendering example

The authored scene uses 42,442 Gaussian primitives plus Three.js materials. Freeze the experiment, move to the Robot camera and select Gaussian mode. Camera movement remains independent from the paused object pose. Imported captures are previewed separately because their coordinates are unverified.

## Replay example

Seek to 12 seconds, pause the research arm, seek to 20 seconds, then rewind before 12 seconds. The arm resumes its authored trajectory before the event. Graph export at the same time is byte identical after reverse seek.

## Review update

Independent review identified local RAD expansion, PLY parser disagreement, context loss recovery, cached navigation disposal and a timeline sequence boundary. RAD import is disabled. The remaining issues were fixed and regression coverage added. Ruflo routing is coordination metadata, not test evidence.

## Validation update

37 local RuLab tests passed, including actual Rust WASM integration. TypeScript and production build passed. Dependency audit reported zero vulnerabilities. The cloud browser exercised the explicit WebGL2 unavailable fallback. Actual WebGL2 execution and desktop/mobile screenshots are required from the GitHub CI workflow before delivery is marked complete.

## First CI rendering evidence

The first RuLab CI run passed six of eight browser tests. It executed real WebGL2 through ANGLE/SwiftShader on desktop and mobile viewports. Gaussian rendering, independent camera presets, byte identical graph replay, bounded local capture import and context loss recovery executed successfully. Two mobile tests failed because responsive text removed numeric button prefixes from accessible names. Explicit accessible names were added and the inspector interaction was corrected.

The existing repository CI passed all five jobs on cb110514733ebf5348fdbea363f777de39b80a0c, including 88 Rust tests, Clippy, both container builds and the authenticated live stream browser test. Final RuLab acceptance remains pending the corrected head.
