import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * Content-Security-Policy cho bản build: app chỉ chạy mã và tải tài nguyên của chính nó,
 * không gọi máy chủ ngoài (NFR-06). Không áp dụng lúc `npm run dev` vì Vite cần script nội tuyến để tải lại nóng.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
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
      registerType: 'autoUpdate',
      // Lưu sẵn cả font để dùng được khi không có mạng (NFR-02).
      workbox: { globPatterns: ['**/*.{js,css,html,svg,woff2}'] },
      manifest: {
        name: 'Hihand Finto',
        short_name: 'Finto',
        lang: 'vi',
        start_url: '/',
        display: 'standalone',
        background_color: '#15131f',
        theme_color: '#15131f',
        icons: [{ src: '/logo.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
      },
    }),
  ],
});
