const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

/** Module-level backend URL — can be updated at runtime via setBackendUrl() */
// Match the backend mode: HTTPS by default, HTTP when HTTPS=false or --http is used
const defaultBackendProtocol = process.env.HTTPS !== 'false' ? 'https' : 'http';
let currentBackendUrl = `${defaultBackendProtocol}://localhost:3001`;
let RELEASE_DIR = path.join(__dirname, '..', 'release');

/**
 * Start a local HTTP server that:
 * 1. Serves static files from the specified directory
 * 2. Proxies /api/* requests to a backend server (supports HTTP + HTTPS)
 * 3. Serves /update/* files from the release directory (for auto-updates)
 */
function startServer(staticDir, backendUrl, releaseDir) {
  if (releaseDir) RELEASE_DIR = releaseDir;
  currentBackendUrl = backendUrl;
  return new Promise((resolve, reject) => {
    const mimeTypes = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
      '.webp': 'image/webp',
      '.woff': 'font/woff',
      '.woff2': 'font/woff2',
      '.ttf': 'font/ttf',
      '.eot': 'application/vnd.ms-fontobject',
    };

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const pathname = url.pathname;

      // CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-User-Id');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      // Serve update files from the release directory (for auto-updates)
      if (pathname.startsWith('/update/')) {
        const updateFile = pathname.replace('/update/', '');
        // Prevent path traversal
        if (updateFile.includes('..') || updateFile.includes('\\')) {
          res.writeHead(400);
          res.end('Invalid path');
          return;
        }
        const filePath = path.join(RELEASE_DIR, updateFile);
        try {
          const data = await fs.promises.readFile(filePath);
          const ext = path.extname(filePath).toLowerCase();
          const contentType =
            ext === '.yml' || ext === '.yaml' ? 'text/yaml' :
            ext === '.exe' ? 'application/octet-stream' :
            'application/octet-stream';
          res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
          res.end(data);
        } catch {
          res.writeHead(404);
          res.end('Not Found');
        }
        return;
      }

      // Proxy /api/* requests to the backend
      if (pathname.startsWith('/api/')) {
        try {
          const backendUrlObj = new URL(currentBackendUrl);
          const isHttps = backendUrlObj.protocol === 'https:';
          const transport = isHttps ? https : http;

          const options = {
            hostname: backendUrlObj.hostname,
            port: backendUrlObj.port || (isHttps ? 443 : 80),
            path: pathname + url.search,
            method: req.method,
            headers: { ...req.headers, host: backendUrlObj.host },
            // Allow self-signed certificates (common for local dev)
            rejectUnauthorized: false,
          };

          // Remove headers that cause issues
          delete options.headers['connection'];

          const proxyReq = transport.request(options, (proxyRes) => {
            // Forward backend response headers as-is.
            // The backend now echoes any request origin (via `(origin) => origin || '*'`),
            // so CORS is handled correctly without overriding anything here.
            const responseHeaders = { ...proxyRes.headers };
            delete responseHeaders['transfer-encoding'];
            res.writeHead(proxyRes.statusCode, responseHeaders);
            proxyRes.pipe(res);
          });

          proxyReq.on('error', (err) => {
            console.error('[server] Proxy error:', err.message);
            // Return 502 Bad Gateway when backend is unreachable
            if (!res.headersSent) {
              res.writeHead(502, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Backend server is unreachable' }));
            }
          });

          // Forward the request body
          if (req.method !== 'GET') {
            req.pipe(proxyReq);
          } else {
            proxyReq.end();
          }
        } catch (err) {
          console.error('[server] Proxy error:', err);
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Backend proxy failed' }));
          }
        }
        return;
      }

      // Serve static files
      let filePath = path.join(staticDir, pathname === '/' ? 'index.html' : pathname);

      // SPA fallback: if file doesn't exist, serve index.html
      try {
        await fs.promises.access(filePath);
      } catch {
        filePath = path.join(staticDir, 'index.html');
      }

      const ext = path.extname(filePath).toLowerCase();
      const contentType = mimeTypes[ext] || 'application/octet-stream';

      try {
        const data = await fs.promises.readFile(filePath);
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
      }
    });

    // Try ports starting from the preferred one
    const startPort = parseInt(process.env.ELECTRON_PORT, 10) || 4173;
    const maxAttempts = 10;

    const tryPort = (port, attempt) => {
      if (attempt > maxAttempts) {
        reject(new Error('Could not find a free port'));
        return;
      }

      server.listen(port, '127.0.0.1', () => {
        const actualPort = server.address().port;
        console.log(`[electron-server] Serving frontend on http://127.0.0.1:${actualPort}`);
        console.log(`[electron-server] Proxying /api to ${currentBackendUrl}`);
        resolve({ server, port: actualPort });
      });

      server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          console.log(`[electron-server] Port ${port} in use, trying ${port + 1}...`);
          server.close();
          tryPort(port + 1, attempt + 1);
        } else {
          reject(err);
        }
      });
    };

    tryPort(startPort, 0);
  });
}

/** Update the backend URL at runtime (no server restart needed) */
function setBackendUrl(newUrl) {
  currentBackendUrl = newUrl;
  console.log(`[electron-server] Backend URL updated to: ${newUrl}`);
}

/** Get the current backend URL */
function getBackendUrl() {
  return currentBackendUrl;
}

module.exports = { startServer, setBackendUrl, getBackendUrl };
