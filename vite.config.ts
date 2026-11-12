import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * Content-Security-Policy for the build: the app only runs its own code and loads its own assets,
 * no external servers (NFR-06). Not applied in `npm run dev` because Vite needs inline scripts for hot reload.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  // Camera preview for scanning QR codes (MediaStream).
  "media-src 'self' blob: mediastream:",
  "font-src 'self'",
  // Live sync: WebSocket to the relay (worker/). Must match SYNC_URL in src/lib/relaySocket.ts / VITE_SYNC_URL.
  `connect-src 'self' ${process.env.VITE_SYNC_URL || 'wss://finto-sync.hihandlabs.online'}`,
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

const csp = (): Plugin => ({
  name: 'hihand-csp',
  apply: 'build',
  transformIndexHtml: (html) => html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
});

export default defineConfig({
  build: { target: 'es2022' },
  plugins: [
    react(),
    csp(),
    VitePWA({
      // When a new version is available, ask ("Tải lại" button) instead of reloading while the user is typing.
      registerType: 'prompt',
      // Precache fonts and icons too so the app works offline (NFR-02).
      workbox: { globPatterns: ['**/*.{js,css,html,svg,woff2,png,ico}'], cleanupOutdatedCaches: true },
      manifest: {
        id: '/',
        name: 'Hihand Finto',
        short_name: 'Finto',
        description: 'Quản lý chi tiêu cá nhân: chia bill, đòi lại, tiền giữ hộ, công nợ. Dữ liệu chỉ nằm trong máy bạn.',
        lang: 'vi',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#15131f',
        theme_color: '#1a1726',
        categories: ['finance', 'productivity'],
        // ?v=N matches index.html: bump both when the icons change (busts iOS / Android icon caches).
        icons: [
          { src: '/icon-192.png?v=3', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icon-512.png?v=3', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icon-maskable-512.png?v=3', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
});
