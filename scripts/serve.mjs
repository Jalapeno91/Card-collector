// Static dev server. The app needs to be served over http rather than opened
// as a file:// URL, because ES modules and service workers both require an
// origin. Run: node scripts/serve.mjs [port]

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

export function createStaticServer(){
  return createServer(async (req, res) => {
    try{
      const url = new URL(req.url, 'http://localhost');
      // normalize() collapses any ../ before it can escape the project root.
      let rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
      if (rel === '/' || rel === '\\') rel = '/index.html';
      const file = join(ROOT, rel);
      if (!file.startsWith(ROOT)){ res.writeHead(403).end('Forbidden'); return; }

      const info = await stat(file);
      const target = info.isDirectory() ? join(file, 'index.html') : file;
      const body = await readFile(target);
      res.writeHead(200, {
        'Content-Type': TYPES[extname(target)] || 'application/octet-stream',
        // The service worker would otherwise happily serve yesterday's code.
        'Cache-Control': 'no-cache',
      });
      res.end(body);
    }catch(e){
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    }
  });
}

// Only start listening when run directly, so the test runner can import this.
if (import.meta.url === `file://${process.argv[1]}`){
  const port = Number(process.argv[2]) || 8765;
  createStaticServer().listen(port, '127.0.0.1', () => {
    console.log(`The Ledger → http://127.0.0.1:${port}/`);
  });
}
