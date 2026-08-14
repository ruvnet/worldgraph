# Self-host the twin stream

The production artifact is the Rust `worldgraph-stream-server`. The supplied
container exposes a health endpoint and the authenticated WebSocket fallback;
it does not bundle model weights, the research-only LingBot provider, or the
browser application.

## Start locally

Create a high-entropy signing secret and keep it out of source control:

```bash
export WORLDGRAPH_TOKEN_SECRET="$(openssl rand -base64 48)"
docker compose up --build --detach
curl --fail http://127.0.0.1:8080/healthz
```

The stream endpoint is `ws://127.0.0.1:8080/v1/twin/ws`. Browser clients
authenticate in the first WebSocket message, before the server returns any
state. Non-browser clients may instead use an `Authorization: Bearer …` header.
The short-lived HS256 JWT must use the configured secret, include `exp`, match
`WORLDGRAPH_TOKEN_AUDIENCE` (default `worldgraph-stream`), and contain only the
scopes the issuer has authorized. Do not put service secrets or tokens in URLs.

An authoritative producer posts versioned envelopes to
`POST /v1/twin/envelopes` with a bearer token containing `twin:write`. Viewer
tokens need `twin:read`; sensitive person tracks and semantic beliefs also need
`twin:sensitive`. The server validates ordering before fan-out and uses the
same privacy projection for snapshots and deltas.

## Internet-facing deployment

Terminate TLS at an HTTP reverse proxy or load balancer and expose the stream
as `wss://…/v1/twin/ws`. Forward the optional `Authorization` header, enable
WebSocket upgrade, apply connection and request-rate limits, and keep `/healthz`
unauthenticated only on a private health-check path. Rotate
`WORLDGRAPH_TOKEN_SECRET` through the deployment platform's secret manager.

The container runs as an unprivileged user with a read-only filesystem, all
Linux capabilities dropped, and `no-new-privileges`. Configure CPU/memory
limits appropriate to the projected viewer count. WebTransport/HTTP3 can be
added at the edge later; clients negotiate down to this WebSocket endpoint.

No external environment is changed by this repository configuration. Running
the compose command deploys the artifact only to the selected Docker host.
