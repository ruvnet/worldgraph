# RuLab security and correctness review

The five findings below have implementation fixes in the reviewed working tree. Source review confirms the fixes. Small parser and timeline checks confirm the previously failing inputs are now rejected or round trip correctly. Browser lifecycle changes still require the separate browser validation gate; source inspection alone is not a browser pass.

## Scope and method

The review covered local Gaussian asset imports, experiment JSON parsing, resource disposal and recovery, the WorldGraph MCP server and validation runner, and the GitHub Pages workflow. Entry points were user-selected files, newline-delimited JSON-RPC on standard input, fixed local validation commands, browser lifecycle events, and pull request or main-branch CI events.

The relevant assets are browser memory and GPU resources, experiment state, local source files, validation evidence, and the public Pages build. Imported files are untrusted. The authored simulation is not measured geometry, learned dynamics, a robot controller, or a safety-certified collision map.

Evidence came from direct code inspection, safe bounded parser fixtures, actual CLI protocol tests, and the matching Spark 2.1.0 Rust decoder source. Ruflo routing and mission planning coordinate work; neither routing confidence nor a caller-supplied success boolean proves execution. The evidence MCP tool explicitly reports `independentlyVerified: false` and checks internal consistency only. This review did not run a separate Ruflo scanner or claim its output as independent validation.

The review made no source fixes, repository setting changes, or deployment changes. It created this report only. Fixes were implemented by the mission coordinator and component owners and then reread independently.

## Findings and verified resolutions

| ID | Original priority | Reachable failure | Resolution in current source | Verification |
| --- | --- | --- | --- | --- |
| RULAB-SEC-001 | P1 | A self-contained RAD file could pass outer metadata checks while an inner compressed property expanded without a size cap inside Spark. | `rulab/src/render/imports.ts` rejects `.rad` in `validateSplatFileEnvelope`, before `arrayBuffer()` or SDK decoding. The message recommends PLY, SPLAT, or SPZ. | Reread the call order and executed a 100-byte `.rad` envelope fixture; it was rejected before file reading. No decompression bomb was executed. |
| RULAB-SEC-002 | P1 | PLY preflight used untrimmed regular expressions and an arbitrary `end_header` substring. A leading-space vertex declaration could be ignored by preflight while the actual decoder selected its count before allocation. | `validatePlyHeader` trims lines, requires a standalone header terminator, tokenizes whitespace, rejects duplicate elements, and validates each element count. | A header with a leading-space 500001-vertex element before a canonical 1-vertex element is now rejected. Reread confirms duplicate element and comment-termination defenses. |
| RULAB-COR-003 | P2 | After successful rendering, a later GPU context loss hid both the recovery message and reference image. | The unavailable branch of `onMetrics` removes the reference image's `rendered` class, sets the notice's `hidden` property to false, and displays the concrete renderer status using `textContent`. | Reread `rulab/src/main.ts` and renderer context-loss/error callbacks. A real or simulated context-loss browser check remains part of browser QA. |
| RULAB-COR-004 | P2 | Unconditional `pagehide` disposal destroyed the renderer and Rust graph even when the browser retained the page in its back/forward cache. Returning did not rerun module initialization. | `pagehide` pauses playback and movement, then preserves resources when `event.persisted` is true. Final disposal cancels the root animation frame and toast timer. `pageshow` resets the frame clock. | Reread the lifecycle handlers. This resolves the identified persisted-page path in code; physical Safari back/forward behavior is not asserted by this report. |
| RULAB-COR-005 | P2 | Import accepted the penultimate safe sequence, recording emitted the maximum safe sequence, and import rejected the resulting export. | Import now accepts every positive safe integer, including `Number.MAX_SAFE_INTEGER`. Recording beyond that bound throws before mutating the branch. | Safe in-memory replay produced revision 9007199254740991, exported and restored it successfully, and rejected the following record. A permanent regression test covers round trip and no mutation. |

RULAB-SEC-001 follows the pinned [Spark 2.1.0 RAD decoder](https://github.com/sparkjsdev/spark/blob/v2.1.0/rust/spark-lib/src/rad.rs#L1617): compressed property data is passed to `miniz_oxide::inflate::decompress_to_vec` before property decoding. The outer Gaussian count does not constrain that temporary allocation.

RULAB-SEC-002 follows the pinned [Spark 2.1.0 PLY header parser](https://github.com/sparkjsdev/spark/blob/v2.1.0/rust/spark-lib/src/ply.rs#L426): it trims whitespace and selects the first vertex element. The [decoder initializes storage from that count](https://github.com/sparkjsdev/spark/blob/v2.1.0/rust/spark-lib/src/ply.rs#L79). No large allocation or denial-of-service attempt was executed.

## Other inspected boundaries

1. Experiment parsing is transactional and bounded to 1 MiB with exactly three scenario branches and at most 1024 events per branch. It checks supported keys, identities, safe sequences, finite timestamps, entity/action compatibility, and duplicate consistency before returning a replacement store.
2. SPLAT imports check 32-byte records and finite bounded coordinates/scales. SPZ preflight streams gzip output with a 96 MiB expansion cap and validates versions 1 through 3, Gaussian count, and harmonic degree before SDK decoding. These bounds limit inputs; they do not guarantee that every supported mobile device can hold the maximum allowed asset.
3. Reviewed user-derived labels, filenames in status messages, and import errors use text output rather than being inserted as HTML. The remaining HTML templates contain authored strings. No reachable prototype-pollution or XSS path was found in the reviewed import flows.
4. MCP input frames are capped at 64 KiB; evidence documents are capped at 48 KiB. Tool arguments have bounded schemas and runtime validation. MCP tools do not execute shell commands. The separate CLI runner invokes fixed command/argument arrays with `shell: false`, bounded logs, timeouts, atomic report writes, and output containment checks.
5. The Pages validation job has `contents: read` and disables persisted checkout credentials. It passes no secret values to the client build. The deploy job receives `pages: write` and `id-token: write` only after validation and only for pushes to main. No application secret embedding or reachable publication permission escalation was found in these files.

## GitHub Pages compatibility and smallest transition

`actions/deploy-pages` can operate with a legacy source branch. Its documented rule is that the deployment must originate from that source branch unless protected environment rules take precedence. Therefore a site sourced from `gh-pages` and a workflow deploying only from `main` are not automatically compatible. Existing environment protection must be checked rather than inferred. [Official deploy-pages security considerations](https://github.com/actions/deploy-pages#security-considerations)

The coordinator reports that WorldGraph currently uses a legacy `gh-pages` source. This reviewer did not independently change or query repository settings. The recommended transition is:

1. Preserve the existing `gh-pages` branch for rollback.
2. After the validated workflow is merged, set repository Settings, Pages, Build and deployment, Source to GitHub Actions. Existing workflow templates need not be added because `.github/workflows/rulab.yml` already provides one. [GitHub publishing-source documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site#publishing-with-a-custom-github-actions-workflow)
3. Restrict the `github-pages` environment to main and retain the workflow's main-push condition. The required build dependency and Pages/OIDC permissions are already present. [GitHub custom workflow requirements](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages#deploying-github-pages-artifacts)
4. Let the successful main-push run deploy, or rerun its failed deployment after changing the setting. A new manual `workflow_dispatch` validates but intentionally does not publish in the current workflow.

For an authorized administrator, the equivalent minimal settings change is a `PUT /repos/ruvnet/worldgraph/pages` request with the body below. Omit unrelated settings to preserve custom domain and HTTPS configuration. This request is a proposal, not an action performed by the review.

```json
{"build_type":"workflow"}
```

GitHub documents Pages write and Administration write permissions for this settings endpoint. Those exceed the existing deploy job token's intentionally narrow permissions. [GitHub Pages settings API](https://docs.github.com/en/rest/pages/pages#update-information-about-a-github-pages-site)

Keeping legacy mode while allowing main through a protected environment is a documented alternative. It leaves both the legacy branch publication path and the custom workflow available. Switching the source to GitHub Actions provides one clear publication path without rewriting the legacy branch.

## Limitations and acceptance

This report is a scoped working-tree review, not an attestation of a merged commit or a public deployment. Source hashes below identify the reviewed bytes. Later edits require rechecking affected findings.

Dependency advisory results and browser performance measurements belong to separate timestamped validation artifacts. This report does not claim a fresh complete dependency audit, trained world-model accuracy, surveyed geometry, simulation safety, physical-device frame-rate targets, or exhaustive memory safety in third-party decoders. Local RAD support is deliberately unavailable pending bounded decoding.

The final acceptance gate is `node bin/cli.js rulab verify` on the proposed source commit with all seven gates executed and no skipped required gate. Independently compare the generated log and artifact hashes with the corresponding CI run. The browser acceptance path should confirm actual WebGL2 rendering, local-import rejection, timeline round trip, visible context-loss recovery, and return from browser history without a disposed graph. Verify the hosted `/worldgraph/` base path after deployment.

## Reviewed source identity

Recorded UTC: 2026-09-06T21:13:51.602451+00:00

Base commit: `360ef48a2536d45033cdbe0c40c0f522b8f75ae7`. Working tree contains uncommitted mission changes.

| File | SHA256 |
| --- | --- |
| `rulab/src/render/imports.ts` | `094c0381f194df0e3b3bb230ebcfe0c421cb46d1275037e1af5d810428233db9` |
| `rulab/src/render/view.ts` | `88bece29397b3953504f50843275da517eadec5c08499c1a7d5ebd2e4920fb98` |
| `rulab/src/main.ts` | `25766001dd03e2a0789c95a65586af791a0c5526a9ef21757f0c4b8d03522600` |
| `rulab/src/world/timeline.ts` | `c9aec7477e7d2512b530fd80d64a7e80df56b393c31b768415787304493e7932` |
| `rulab/src/world/timeline.test.ts` | `0ced09ed1fd467df52c2b8c39087904473ec93a6e372a50281b4dfda1f63d148` |
| `bin/mcp-server.js` | `481d88fa712ae233561234bd225a916f164a7ddfb41a7b78cbbd5747936649a2` |
| `bin/rulab-harness.js` | `477d64a558f4b3287171df4a0ee45acf394458d75f1183048eeabc8888aa8f29` |
| `.github/workflows/rulab.yml` | `44a9581010e5ae5a6625f7e58941d3bfee6060fc6474a7ff7956d8d20eddfa72` |
| `package-lock.json` | `84c22a662311e03ae5639f6acbae293b2752b13b1dafd292e5dfa1a496c93831` |
| `rulab/package-lock.json` | `7adf929fd211bf5332b3150cb1aed6f71e0c6dc0113adab0f483ca7b6daa2858` |
