/**
 * Minimal static file server for the browser client (no framework). Only GET
 * and HEAD are served, paths are confined to the configured roots, and every
 * response carries a strict Content-Security-Policy.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
    + "connect-src 'self' ws: wss:; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

/**
 * Build a request handler serving files from URL prefixes.
 * @param {Array<{prefix:string, dir:string}>} mounts Longest prefix wins; `dir` absolute.
 * @param {(req, res) => boolean} [extra] Called first; return true if it handled the request.
 */
export function createStaticHandler(mounts, extra = () => false) {
  const sorted = [...mounts].sort((a, b) => b.prefix.length - a.prefix.length);
  return async function handle(req, res) {
    try {
      if (extra(req, res)) return;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD', ...SECURITY_HEADERS });
        res.end();
        return;
      }
      const url = new URL(req.url, 'http://localhost');
      let pathname;
      try { pathname = decodeURIComponent(url.pathname); } catch { pathname = null; }
      if (!pathname || pathname.includes('\0')) return notFound(res);

      const mount = sorted.find((m) => pathname.startsWith(m.prefix));
      if (!mount) return notFound(res);
      let rel = pathname.slice(mount.prefix.length);
      if (rel === '' || rel.endsWith('/')) rel += 'index.html';
      const file = path.resolve(mount.dir, `.${path.posix.sep}${rel}`);
      if (file !== mount.dir && !file.startsWith(mount.dir + path.sep)) return notFound(res);
      const ext = path.extname(file).toLowerCase();
      const type = MIME[ext];
      if (!type || path.basename(file).startsWith('.') || path.basename(file) === 'CLAUDE.md') return notFound(res);

      let stat;
      try { stat = await fs.stat(file); } catch { return notFound(res); }
      if (!stat.isFile()) return notFound(res);

      const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
      const headers = {
        ...SECURITY_HEADERS,
        'Content-Type': type,
        'Cache-Control': 'no-cache',
        ETag: etag,
      };
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, headers);
        res.end();
        return;
      }
      const body = await fs.readFile(file);
      res.writeHead(200, { ...headers, 'Content-Length': body.length });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      if (!res.headersSent) res.writeHead(500, SECURITY_HEADERS);
      res.end();
    }
  };
}

function notFound(res) {
  res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Introuvable');
}
