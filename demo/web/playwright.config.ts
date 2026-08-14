import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 120_000,
  expect: { timeout: 30_000 },
  use: { baseURL: 'http://127.0.0.1:4173', headless: true, screenshot: 'only-on-failure' },
  webServer: [
    {
      command: 'cargo run -p worldgraph-stream --features server --bin worldgraph-stream-server',
      cwd: '../..',
      url: 'http://127.0.0.1:8080/healthz',
      timeout: 120_000,
      env: {
        WORLDGRAPH_BIND: '127.0.0.1:8080',
        WORLDGRAPH_DEMO_MODE: '1',
        WORLDGRAPH_TOKEN_SECRET: 'worldgraph-e2e-secret-at-least-32-bytes',
        WORLDGRAPH_TOKEN_AUDIENCE: 'worldgraph-stream'
      }
    },
    { command: 'npm run dev', cwd: '.', url: 'http://127.0.0.1:4173', timeout: 120_000 }
  ]
});
