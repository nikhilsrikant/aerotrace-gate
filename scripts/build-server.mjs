// Bundles the CLI (migrate, worker, admin commands) into one file for the container.
import { build } from 'esbuild';
const common = { bundle: true, platform: 'node', target: 'node22', format: 'esm', external: ['pg-native'],
  banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" }, logLevel: 'warning', sourcemap: 'linked' };
// cli.mjs: migrate, worker and admin commands. boot.mjs: prepares the web process (secret refs, telemetry), then starts Next.js.
await build({ ...common, entryPoints: ['lib/server/cli.ts'], outfile: 'dist/cli.mjs' });
await build({ ...common, entryPoints: ['lib/server/boot.ts'], outfile: 'dist/boot.mjs' });
console.log('dist/cli.mjs and dist/boot.mjs built');
