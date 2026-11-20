// Bundles the server (and the workspace packages it imports) into dist/main.js.
// Third-party packages stay external and are resolved from node_modules at runtime.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const simPkg = JSON.parse(readFileSync(new URL('../simulator/package.json', import.meta.url), 'utf8'));
const external = [...Object.keys(pkg.dependencies), ...Object.keys(simPkg.dependencies)].filter(
  (d) => !d.startsWith('@athena-sky/'),
);

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.js',
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
