import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import type { ClientRequest, IncomingMessage } from 'node:http';

function forwardLocalOrigin(outgoing: ClientRequest, incoming: IncomingMessage) {
  if (incoming.headers.origin === 'http://127.0.0.1:5173' || incoming.headers.origin === 'http://localhost:5173') {
    outgoing.setHeader('Origin', 'http://127.0.0.1:38475');
  }
}

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:38475', changeOrigin: true,
        configure: proxy => { proxy.on('proxyReq', forwardLocalOrigin); },
      },
      '/ws': {
        target: 'ws://127.0.0.1:38475', changeOrigin: true, ws: true,
        configure: proxy => { proxy.on('proxyReqWs', forwardLocalOrigin); },
      },
    },
  },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});
