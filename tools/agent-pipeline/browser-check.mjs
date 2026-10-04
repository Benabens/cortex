#!/usr/bin/env node
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(dir, '../../cortex');
// esbuild est déjà fourni par tsx : aucun paquet installé pour ce banc.
const require = createRequire(path.join(app, 'package.json'));
const { build } = require('esbuild');
const bundle = await build({
  entryPoints: [path.join(dir, 'browser-fixture.tsx')],
  bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
  tsconfig: path.join(app, 'tsconfig.json'), nodePaths: [path.join(app, 'node_modules')],
  plugins: [{
    name: 'services-simules',
    setup(builder) {
      builder.onResolve({ filter: /^(next-auth\/react|next\/link)$/ }, (args) => ({ path: args.path, namespace: 'mock' }));
      builder.onLoad({ filter: /.*/, namespace: 'mock' }, (args) => ({
        contents: args.path === 'next-auth/react'
          ? 'export async function signOut() { return new Promise(()=>{}); }'
          : 'export default function Link(props) { return <a {...props}/>; }',
        loader: 'jsx', resolveDir: app,
      }));
    },
  }],
});
const html = `<!DOCTYPE html><html lang="fr"><meta charset="utf-8"><title>Banc du pipeline Cortex</title>
<style>body{background:#15151a;color:#eee;font:16px system-ui;margin:24px}button,input,textarea{font:inherit;margin:5px;padding:8px;background:#282830;color:#eee;border:1px solid #777}textarea{display:block;width:90%}[role=dialog]{position:fixed;inset:10% 25%;background:#252530;border:2px solid white;padding:30px;overflow:auto;z-index:50}button:disabled{opacity:.4}pre{white-space:pre-wrap}hr{margin:30px 0}</style>
<div id="root"></div><script src="/bundle.js"></script></html>`;
const server = createServer((req, res) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'none'");
  if (req.url === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); }
  else if (req.url === '/bundle.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(bundle.outputFiles[0].contents); }
  else { res.writeHead(404); res.end(); }
});
server.listen(8769, '127.0.0.1', () => console.log('Banc synthétique : http://127.0.0.1:8769/ — Ctrl+C pour arrêter.'));
