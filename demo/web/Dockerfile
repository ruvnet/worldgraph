# syntax=docker/dockerfile:1.7

FROM rust:1.97-slim-bookworm AS wasm-builder
WORKDIR /src
RUN rustup target add wasm32-unknown-unknown \
    && cargo install wasm-pack --version 0.14.0 --locked
COPY . .
RUN wasm-pack build worldgraph-wasm \
    --release \
    --target web \
    --out-name worldgraph_wasm \
    --out-dir /out/wasm

FROM node:24-bookworm-slim AS web-builder
WORKDIR /src
COPY supersplat-bridge ./supersplat-bridge
COPY demo/web ./demo/web
COPY --from=wasm-builder /out/wasm ./demo/web/public/wasm
WORKDIR /src/demo/web
RUN npm ci
RUN npm run build:web

FROM nginxinc/nginx-unprivileged:1.29-alpine AS runtime
COPY demo/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=web-builder /src/demo/web/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=3s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:8080/healthz || exit 1
