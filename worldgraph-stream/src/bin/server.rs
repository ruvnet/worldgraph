//! Standalone authenticated WorldGraph stream server.

use std::{
    env,
    net::SocketAddr,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use wifi_densepose_geo::GeoRegistration;
use wifi_densepose_worldgraph::WorldGraph;
use worldgraph_stream::server::{self, JwtTokenValidator, StreamHub};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let bind: SocketAddr = env::var("WORLDGRAPH_BIND")
        .unwrap_or_else(|_| "0.0.0.0:8080".into())
        .parse()?;
    let secret = env::var("WORLDGRAPH_TOKEN_SECRET")
        .map_err(|_| "WORLDGRAPH_TOKEN_SECRET is required and must contain at least 32 bytes")?;
    let audience =
        env::var("WORLDGRAPH_TOKEN_AUDIENCE").unwrap_or_else(|_| "worldgraph-stream".into());
    let validator = Arc::new(JwtTokenValidator::new(secret.as_bytes(), &audience)?);
    let epoch = format!(
        "boot-{}",
        SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs()
    );
    let hub = StreamHub::new(
        epoch,
        WorldGraph::new(GeoRegistration::default()).snapshot(),
    );
    server::serve(bind, hub, validator).await?;
    Ok(())
}
