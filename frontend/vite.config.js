import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
// Detect backend protocol using a signal file created by start.bat --http
// This is reliable because file system operations work across process boundaries
// (unlike environment variables which don't propagate through `start` cmd)
var httpSignalFile = join(process.cwd(), '..', '.http-mode');
var backendProtocol = existsSync(httpSignalFile) ? 'http' : 'https';
var backendTarget = "".concat(backendProtocol, "://localhost:3001");
export default defineConfig({
    plugins: [react()],
    server: {
        host: '0.0.0.0', // listen on all network interfaces
        port: 5173,
        strictPort: true, // fail if 5173 is taken, so you know
        https: {
            cert: readFileSync('../certs/localhost.crt'),
            key: readFileSync('../certs/localhost.key'),
        },
        proxy: {
            '/api': {
                target: backendTarget,
                changeOrigin: true,
                secure: false, // allow self-signed certs locally
            },
            '/download': {
                target: backendTarget,
                changeOrigin: true,
                secure: false,
            },
        },
    },
});
