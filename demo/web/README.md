# Worldgraph live browser demo

This demo uses the real `worldgraph-stream` server and compiled
`worldgraph-wasm`; it does not use the test fake bridge.

```bash
WORLDGRAPH_DEMO_MODE=1 \
WORLDGRAPH_TOKEN_SECRET=worldgraph-demo-secret-at-least-32-bytes \
cargo run -p worldgraph-stream --features server --bin worldgraph-stream-server

cd demo/web
npm install
npm run build:wasm
npm run dev
```

Open <http://127.0.0.1:4173>. Vite proxies `/demo` and `/v1` to the server at
`WORLDGRAPH_STREAM_ORIGIN` (default `http://127.0.0.1:8080`). The demo bootstrap
endpoint exists only when the server is explicitly in demo mode and returns a
short-lived token; production never exposes token minting.

`npm run test:e2e` starts both services, verifies a real snapshot, waits for a
later sequence, verifies presence, and writes `test-results/live-demo.png`.

## Containerized demo

From the repository root, build and run both the Rust stream service and the
production static UI/reverse proxy:

```bash
docker compose -f compose.yaml -f compose.demo.yaml up --build
```

Open <http://127.0.0.1:4173>. Set `WORLDGRAPH_DEMO_PORT` to change the UI port.
The nginx container serves the compiled application and real WASM, proxies
`/demo` and WebSocket `/v1` traffic to the private Compose service name, and
keeps browser credentials and streaming same-origin. The published UI binds to
loopback by default. The demo overlay is required to enable token minting; the
base production Compose file retains fail-closed authentication defaults.
