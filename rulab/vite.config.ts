import { defineConfig } from 'vite';
export default defineConfig({
  base: process.env.WORLDGRAPH_BASE_PATH || '/worldgraph/',
  server: { host: '0.0.0.0', port: 4173, strictPort: true, allowedHosts: ['terminal.local'] },
  preview: { host: '0.0.0.0', port: 4173, strictPort: true, allowedHosts: ['terminal.local'] },
  build: { target: 'es2022', chunkSizeWarningLimit: 1800 },
});
