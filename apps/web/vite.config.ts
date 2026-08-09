import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      // 只用「主屏图标 + 离线缓存 + 秒开」，不启用 Web Push
      // （iOS 的 Web Push 需用户先添加到主屏幕且无后台执行，日报走服务端 Cron + IM webhook）
      manifest: {
        name: '基金持仓追踪',
        short_name: '持仓',
        description: '中国大陆公募基金持仓追踪与实时估值',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        icons: [
          { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,woff2}'],
        // API 响应不进预缓存，由 TanStack Query 管理；离线时展示上次持仓
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            urlPattern: /^\/api\/(portfolio|funds)\//,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'lookthru-api',
              networkTimeoutSeconds: 5,
              expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 7 },
            },
          },
        ],
      },
    }),
  ],
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  server: {
    // 本地开发：前端 5173，wrangler dev 8787
    proxy: {
      '/api': { target: 'http://localhost:8787', changeOrigin: true },
    },
  },
});
