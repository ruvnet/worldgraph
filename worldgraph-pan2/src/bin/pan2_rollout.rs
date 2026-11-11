//! `pan2-rollout` — client tool for PAN 2 rollouts.
//!
//! ```text
//! pan2-rollout caption <plan.json>
//! pan2-rollout <caption|from-spaces|generate --plan <plan.json> --socket <path> --out <envelope.json>
//!                       (--hosted | --weights <dir>) --accept-terms [--timeout-min 120]
//! pan2-rollout accept   --plan <plan.json> --envelope <envelope.json> --media-root <dir>
//!                       --out <bundle dir> [--first-frame <image>]
//!                       [--site <id> --space <id> --event-out <file> [--media-url <url>]]
//! pan2-rollout verify   <bundle dir>
//! pan2-rollout publish  --event <file> --base-url <url> --key-env <VAR>   (feature spaces-http)
//! ```
//!
//! `generate` talks to the worker and saves the envelope. Copy the worker's
//! media directory over your own channel, then `accept` verifies every file,
//! writes the RuLab bundle, and prints the graph record.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use wifi_densepose_worldgraph::WorldGraph;
use wifi_densepose_worldmodel::SimulatedFrameEnvelope;
use worldgraph_pan2::bundle::read_bundle;
use worldgraph_pan2::compile::compile;
use worldgraph_pan2::pipeline::{accept, generate, pan2_provider, Generated, WorkerPlacement};
use worldgraph_pan2::plan::RolloutPlan;
use worldgraph_pan2::spaces::{rollout_event, EventIdentity, SpacesTarget};
use worldgraph_pan2::spaces_scene::{PlanOptions, SpacesSnapshot};
use worldgraph_pan2::Pan2Error;

fn invalid(message: impl Into<String>) -> Pan2Error {
    Pan2Error::InvalidInput(message.into())
}

/// Parses `--flag value` pairs; flags listed in `switches` take no value.
fn flags(args: &[String], switches: &[&str]) -> Result<BTreeMap<String, String>, Pan2Error> {
    let mut values = BTreeMap::new();
    let mut index = 0;
    while index < args.len() {
        let name = args[index]
            .strip_prefix("--")
            .ok_or_else(|| invalid(format!("unexpected argument `{}`", args[index])))?;
        let value = if switches.contains(&name) {
            "true".to_owned()
        } else {
            index += 1;
            args.get(index)
                .cloned()
                .ok_or_else(|| invalid(format!("`--{name}` needs a value")))?
        };
        values.insert(name.to_owned(), value);
        index += 1;
    }
    Ok(values)
}

fn required(values: &BTreeMap<String, String>, name: &str) -> Result<String, Pan2Error> {
    values
        .get(name)
        .cloned()
        .ok_or_else(|| invalid(format!("missing --{name}")))
}

fn load_plan(path: &str) -> Result<RolloutPlan, Pan2Error> {
    RolloutPlan::from_json(&std::fs::read(path)?)
}

fn caption(path: &str) -> Result<(), Pan2Error> {
    let (seed, action) = load_plan(path)?.into_inputs(0, 0)?;
    let compiled = compile(&seed, &action)?;
    eprintln!(
        "task {:?} · {} s · {} frames · {} caption bytes · sha256 {}",
        compiled.task,
        compiled.duration_sec(),
        compiled.frames,
        compiled.prompt.len(),
        compiled.prompt_sha256
    );
    println!("{}", serde_json::to_string_pretty(&compiled.caption)?);
    Ok(())
}

async fn run_generate(args: &[String]) -> Result<(), Pan2Error> {
    let values = flags(args, &["hosted", "accept-terms"])?;
    let plan = load_plan(&required(&values, "plan")?)?;
    let placement = match (values.contains_key("hosted"), values.get("weights")) {
        (true, None) => WorkerPlacement::Hosted,
        (false, Some(path)) => WorkerPlacement::Local {
            weights_path: PathBuf::from(path),
        },
        _ => return Err(invalid("give exactly one of --hosted or --weights <dir>")),
    };
    let minutes: u64 = values
        .get("timeout-min")
        .map(|text| {
            text.parse()
                .map_err(|_| invalid("--timeout-min must be a whole number"))
        })
        .transpose()?
        .unwrap_or(120);
    let provider = pan2_provider(
        required(&values, "socket")?,
        Duration::from_secs(minutes * 60),
        placement,
        values.contains_key("accept-terms"),
    )?;
    let generated = generate(&provider, &plan).await?;
    let out = required(&values, "out")?;
    std::fs::write(&out, serde_json::to_vec_pretty(&generated.envelope)?)?;
    eprintln!("envelope written to {out}; copy the worker media directory, then run `accept`");
    Ok(())
}

fn run_accept(args: &[String]) -> Result<(), Pan2Error> {
    let values = flags(args, &[])?;
    let plan = load_plan(&required(&values, "plan")?)?;
    let envelope: SimulatedFrameEnvelope =
        serde_json::from_slice(&std::fs::read(required(&values, "envelope")?)?)?;
    let (seed, action) = plan.into_inputs(0, 0)?;
    let generated = Generated {
        prompt: compile(&seed, &action)?,
        envelope,
    };
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0);
    let mut graph = WorldGraph::new(Default::default());
    let out_dir = PathBuf::from(required(&values, "out")?);
    let recorded = accept(
        &generated,
        &plan,
        Path::new(&required(&values, "media-root")?),
        &out_dir,
        values.get("first-frame").map(Path::new),
        &mut graph,
        &[],
        now_ms,
    )?;
    eprintln!(
        "verified bundle written to {} (clip sha256 {})",
        out_dir.display(),
        recorded.manifest.media.sha256
    );
    println!(
        "{}",
        serde_json::to_string_pretty(graph.node(recorded.state_id).expect("node was just added"))?
    );

    if let (Some(site), Some(space)) = (values.get("site"), values.get("space")) {
        let envelope = &generated.envelope;
        let step = format!(
            "{}.e{}-s{}",
            envelope.session_id, envelope.epoch, envelope.sequence
        );
        let event = rollout_event(
            envelope,
            &SpacesTarget {
                site_id: site.clone(),
                space_id: space.clone(),
            },
            &EventIdentity {
                id: format!("rollout:{step}"),
                message_id: format!("rollout-msg:{step}"),
                event_sequence: (now_ms.max(0) as u64) / 1000,
                observed_at: rfc3339_utc(now_ms),
            },
            values.get("media-url").map(String::as_str),
        )?;
        let event_out = required(&values, "event-out")?;
        std::fs::write(&event_out, serde_json::to_vec_pretty(&event)?)?;
        eprintln!("Spaces event written to {event_out} (not sent)");
    }
    Ok(())
}

/// `YYYY-MM-DDTHH:MM:SSZ` for a Unix time in milliseconds.
fn rfc3339_utc(unix_ms: i64) -> String {
    let seconds = unix_ms.div_euclid(1000);
    let (days, rest) = (seconds.div_euclid(86_400), seconds.rem_euclid(86_400));
    // Civil-from-days (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rest / 3600,
        rest % 3600 / 60,
        rest % 60
    )
}

#[cfg(feature = "spaces-http")]
async fn run_publish(args: &[String]) -> Result<(), Pan2Error> {
    let values = flags(args, &[])?;
    let event: serde_json::Value =
        serde_json::from_slice(&std::fs::read(required(&values, "event")?)?)?;
    let variable = required(&values, "key-env")?;
    let key = std::env::var(&variable)
        .map_err(|_| invalid(format!("environment variable `{variable}` is not set")))?;
    let (status, body) =
        worldgraph_pan2::spaces::publish_event(&required(&values, "base-url")?, &key, &event)
            .await?;
    println!("{status} {body}");
    Ok(())
}

#[cfg(not(feature = "spaces-http"))]
async fn run_publish(_args: &[String]) -> Result<(), Pan2Error> {
    Err(invalid(
        "rebuild with `--features spaces-http` to publish to Spaces",
    ))
}

/// Builds a plan from a Cognitum Spaces snapshot.
fn run_from_spaces(args: &[String]) -> Result<(), Pan2Error> {
    let values = flags(args, &["approve-hosted"])?;
    let number = |name: &str, default: u64| match values.get(name) {
        Some(text) => text
            .parse()
            .map_err(|_| invalid(format!("`--{name}` must be a whole number"))),
        None => Ok(default),
    };
    let snapshot = SpacesSnapshot::from_json(&std::fs::read(required(&values, "snapshot")?)?)?;
    let plan = snapshot.to_plan(&PlanOptions {
        duration_sec: number("duration", 20)? as u32,
        generation_seed: number("seed", 123)?,
        hosted_processing_approved: values.contains_key("approve-hosted"),
    })?;
    let out = required(&values, "out")?;
    std::fs::write(&out, serde_json::to_vec_pretty(&plan)?)?;
    println!(
        "plan written to {out} from snapshot {}",
        plan.source_snapshot_hash
    );
    Ok(())
}

async fn run() -> Result<(), Pan2Error> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.split_first() {
        Some((command, rest)) if command == "caption" && rest.len() == 1 => caption(&rest[0]),
        Some((command, rest)) if command == "from-spaces" => run_from_spaces(rest),
        Some((command, rest)) if command == "generate" => run_generate(rest).await,
        Some((command, rest)) if command == "accept" => run_accept(rest),
        Some((command, rest)) if command == "publish" => run_publish(rest).await,
        Some((command, rest)) if command == "verify" && rest.len() == 1 => {
            let manifest = read_bundle(Path::new(&rest[0]))?;
            println!("ok: {} · clip sha256 {}", manifest.name, manifest.media.sha256);
            Ok(())
        }
        _ => Err(invalid(
            "usage: pan2-rollout <caption|generate|accept|verify|publish> ... (see the crate README)",
        )),
    }
}

#[tokio::main]
async fn main() -> ExitCode {
    match run().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("pan2-rollout: {error}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::rfc3339_utc;

    #[test]
    fn timestamps_are_rfc3339_utc() {
        assert_eq!(rfc3339_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339_utc(951_782_400_000), "2000-02-29T00:00:00Z");
        assert_eq!(rfc3339_utc(1_794_355_199_000), "2026-11-10T23:59:59Z");
    }
}
