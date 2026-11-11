//! Caption compiler cost. Runs anywhere; no GPU and no model involved.
#![allow(missing_docs)]

use std::hint::black_box;

use criterion::{criterion_group, criterion_main, Criterion};
use wifi_densepose_worldmodel::ScenePrimitive;
use worldgraph_pan2::compile::compile;
use worldgraph_pan2::plan::{CameraKey, PlanAction, PlanEvent, PlanSubject, RolloutPlan};

fn plan(primitives: usize, events: u32) -> RolloutPlan {
    RolloutPlan {
        name: "bench".into(),
        source_snapshot_hash: "sha256:bench".into(),
        source_stream_epoch: 1,
        generation_seed: 1,
        projection_id: "bench".into(),
        hosted_processing_approved: true,
        redactions_applied: 0,
        duration_sec: f64::from(events) * 2.0,
        first_frame: "A research lab seen from its entrance.".into(),
        scene: (0..primitives)
            .map(|index| ScenePrimitive::Box {
                center_m: [index as f32 % 7.0 - 3.0, index as f32 % 5.0, 0.5],
                size_m: [1.0, 1.0, 1.0],
                class: format!("fixture_{}", index % 9),
            })
            .collect(),
        style: None,
        lighting: None,
        view: None,
        subjects: vec![PlanSubject {
            name: "Robot".into(),
            attribute: "White wheeled robot.".into(),
        }],
        events: (1..=events)
            .map(|index| PlanEvent {
                until_sec: f64::from(index) * 2.0,
                description: "The robot continues along the aisle.".into(),
            })
            .collect(),
        actions: (0..events)
            .map(|index| PlanAction {
                from_sec: f64::from(index) * 2.0,
                to_sec: f64::from(index) * 2.0 + 1.5,
                subject: 1,
                action: "drives forward along the aisle.".into(),
            })
            .collect(),
        camera: (0..events)
            .map(|index| CameraKey {
                at_sec: f64::from(index) * 2.0,
                translation: [0.0, if index % 2 == 0 { 0.4 } else { 0.0 }, 0.0],
                rotation: [0.0; 3],
                zoom: 0.0,
            })
            .collect(),
        image: None,
    }
}

fn caption(criterion: &mut Criterion) {
    for (label, primitives, events) in [
        ("small_2prim_2ev", 2, 2),
        ("large_4096prim_10ev", 4_096, 10),
    ] {
        let plan = plan(primitives, events);
        criterion.bench_function(&format!("plan_into_inputs/{label}"), |bench| {
            bench.iter(|| black_box(&plan).into_inputs(0, 0).unwrap())
        });
        let (seed, action) = plan.into_inputs(0, 0).unwrap();
        criterion.bench_function(&format!("compile/{label}"), |bench| {
            bench.iter(|| compile(black_box(&seed), black_box(&action)).unwrap())
        });
    }
}

criterion_group!(benches, caption);
criterion_main!(benches);
