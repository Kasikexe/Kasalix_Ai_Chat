import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'fs';
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
                target: 'https://localhost:3001',
                changeOrigin: true,
                secure: false, // allow self-signed certs locally
            },
            '/download': {
                target: 'https://localhost:3001',
                changeOrigin: true,
                secure: false,
            },
        },
    },
});
