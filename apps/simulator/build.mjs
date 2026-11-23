import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
for (const [entry, outfile] of [
  ['src/main.ts', 'dist/main.js'],
  ['src/authority-main.ts', 'dist/utm-authority.js'],
]) {
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    sourcemap: true,
    external: Object.keys(pkg.dependencies).filter((d) => !d.startsWith('@athena-sky/')),
    logLevel: 'info',
  });
}
