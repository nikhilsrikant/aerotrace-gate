// Bundles the same UI and engine into one self-contained HTML page (no server needed).
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const r = await build({ entryPoints: ['ui/demo-entry.tsx'], bundle: true, minify: true, format: 'iife', write: false, jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'error', target: 'es2020' });
const js = r.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const css = readFileSync('ui/styles.css', 'utf8');
const html = `<title>AeroTrace Gate</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&family=IBM+Plex+Sans+Condensed:wght@600;700&family=IBM+Plex+Sans:wght@400;600&display=swap">
<style>${css}</style>
<div id="root"></div>
<script>${js}</script>
`;
mkdirSync('demo', { recursive: true });
writeFileSync('demo/index.html', html);
console.log(`demo/index.html ${(html.length / 1024).toFixed(0)} KB`);
