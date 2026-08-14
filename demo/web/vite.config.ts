import { defineConfig } from 'vite';

const streamOrigin = process.env.WORLDGRAPH_STREAM_ORIGIN ?? 'http://127.0.0.1:8080';

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
    proxy: {
      '/demo': { target: streamOrigin, changeOrigin: true },
      '/v1': { target: streamOrigin, changeOrigin: true, ws: true }
    }
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
    proxy: {
      '/demo': { target: streamOrigin, changeOrigin: true },
      '/v1': { target: streamOrigin, changeOrigin: true, ws: true }
    }
  }
});
