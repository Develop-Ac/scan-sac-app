// Servidor estatico minimo (zero dependencia) para o PWA de scan.
// Serve ./public com MIME correto e no-cache em sw.js/config.js.
import http from 'node:http';
import { stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 8080);
// URL do backend. Se API_BASE estiver definido, o config.js e servido a partir dele
// (config por ambiente, sem editar arquivo dentro da imagem). Nao deve terminar com "/".
const API_BASE = (process.env.API_BASE || '').trim().replace(/\/+$/, '');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

const server = http.createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);

    // config.js gerado por ambiente quando API_BASE esta definido (senao serve o arquivo estatico).
    if ((urlPath === '/config.js' || urlPath === '/config.js/') && process.env.API_BASE !== undefined) {
      const body = `window.APP_CONFIG = { apiBase: ${JSON.stringify(API_BASE)} };\n`;
      res.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      return res.end(body);
    }

    const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
    let filePath = path.normalize(path.join(ROOT, rel));

    // impede path traversal para fora de ROOT
    if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }

    let s = await stat(filePath).catch(() => null);
    if (s && s.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
      s = await stat(filePath).catch(() => null);
    }
    if (!s) {
      // fallback do PWA -> index.html
      filePath = path.join(ROOT, 'index.html');
    }

    const ext = path.extname(filePath).toLowerCase();
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    const base = path.basename(filePath);
    if (base === 'sw.js' || base === 'config.js') headers['Cache-Control'] = 'no-cache';

    res.writeHead(200, headers);
    createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(500);
    res.end('Erro interno');
  }
});

server.listen(PORT, () => console.log(`[escaner-fiscal-app] estatico em http://0.0.0.0:${PORT}`));
