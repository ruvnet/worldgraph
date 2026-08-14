# syntax=docker/dockerfile:1.7
FROM rust:1.97-slim-bookworm AS builder

WORKDIR /src
RUN apt-get update \
    && apt-get install --yes --no-install-recommends pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/*
COPY . .
RUN cargo build --locked --release \
    -p worldgraph-stream \
    --features server \
    --bin worldgraph-stream-server

FROM debian:bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /src/target/release/worldgraph-stream-server /usr/local/bin/worldgraph-stream-server

USER 65532:65532
ENV WORLDGRAPH_BIND=0.0.0.0:8080
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
    CMD curl --fail --silent http://127.0.0.1:8080/healthz >/dev/null || exit 1

ENTRYPOINT ["worldgraph-stream-server"]
