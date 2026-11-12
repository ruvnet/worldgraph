//! Control-plane overhead of one rollout with the renderer faked out:
//! socket round trips, caption compile on both sides, file hashing, bundle
//! write and graph record. This is NOT model speed; the model is not run.

#![allow(missing_docs)]

#[path = "../tests/common/mod.rs"]
mod common;

use std::time::Duration;

use criterion::{criterion_group, criterion_main, Criterion};
use wifi_densepose_worldgraph::WorldGraph;
use worldgraph_pan2::pipeline::{accept, generate, pan2_provider, WorkerPlacement};

fn sidecar(criterion: &mut Criterion) {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let harness = runtime.block_on(common::start("bench", false));
    let provider = pan2_provider(
        &harness.socket,
        Duration::from_secs(10),
        WorkerPlacement::Hosted,
        true,
    )
    .unwrap();
    let plan = common::door_plan();

    criterion.bench_function("sidecar/initialize_step_finish", |bench| {
        bench.iter(|| runtime.block_on(generate(&provider, &plan)).unwrap())
    });

    let generated = runtime.block_on(generate(&provider, &plan)).unwrap();
    let out = common::temp_dir("bench-out");
    criterion.bench_function("accept/verify_bundle_record", |bench| {
        bench.iter(|| {
            let mut graph = WorldGraph::new(Default::default());
            accept(
                &generated,
                &plan,
                &harness.media_root,
                &out,
                None,
                &mut graph,
                &[],
                0,
            )
            .unwrap()
        })
    });
    let _ = std::fs::remove_dir_all(out);
}

criterion_group!(benches, sidecar);
criterion_main!(benches);
