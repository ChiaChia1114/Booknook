import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const cesiumBuild = join(dirname(require.resolve('cesium/package.json')), 'Build', 'Cesium').replace(/\\/g, '/');
const apiTarget = process.env.ATHENA_API ?? 'http://localhost:8080';

export default defineConfig({
  plugins: [
    react(),
    viteStaticCopy({
      targets: ['Workers', 'ThirdParty', 'Assets', 'Widgets'].map((d) => ({ src: `${cesiumBuild}/${d}`, dest: 'cesium' })),
    }),
  ],
  define: {
    CESIUM_BASE_URL: JSON.stringify('/cesium'),
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: apiTarget, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 6000,
  },
});
