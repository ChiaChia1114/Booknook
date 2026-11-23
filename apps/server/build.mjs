// Bundles the server (and the workspace packages it imports) into dist/main.js.
// Third-party packages stay external and are resolved from node_modules at runtime.
import { build } from 'esbuild';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const simPkg = JSON.parse(readFileSync(new URL('../simulator/package.json', import.meta.url), 'utf8'));
const external = [...Object.keys(pkg.dependencies), ...Object.keys(simPkg.dependencies)].filter(
  (d) => !d.startsWith('@athena-sky/'),
);

// The AI vision worker and the demo drones' worker are further entry points; the detector model sits next to them.
mkdirSync('dist', { recursive: true });
if (existsSync('src/vision/athena-detector.json')) copyFileSync('src/vision/athena-detector.json', 'dist/athena-detector.json');

await build({
  entryPoints: { main: 'src/main.ts', 'vision-worker': 'src/vision/vision-worker.ts', 'demo-worker': 'src/demo/demo-worker.ts' },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  external,
  banner: {
    js: "import { createRequire as __athenaCreateRequire } from 'node:module'; const require = __athenaCreateRequire(import.meta.url);",
  },
  logLevel: 'info',
});
