//! Prints the compiled PAN 2 caption for a plan JSON file: the exact text the renderers send to the model.
//!
//! `cargo run -p worldgraph-pan2 --example caption_dump -- <plan.json>`
//!
//! Line 1 is the caption; line 2 is `frames=<n> duration_ds=<n> sha256=<hex>`. Used to give quantization
//! experiments the same structured prompt the real pipeline uses, not a plain sentence.

use worldgraph_pan2::compile::compile;
use worldgraph_pan2::plan::RolloutPlan;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args().nth(1).ok_or("usage: caption_dump <plan.json>")?;
    let plan: RolloutPlan = serde_json::from_str(&std::fs::read_to_string(path)?)?;
    let (seed, action) = plan.into_inputs(0, 0)?;
    let compiled = compile(&seed, &action)?;
    println!("{}", compiled.prompt);
    eprintln!("frames={} duration_ds={} sha256={}", compiled.frames, compiled.duration_ds, compiled.prompt_sha256);
    Ok(())
}
