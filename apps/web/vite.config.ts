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
        // 与设计令牌一致：page / root。不一致会在启动图与状态栏区域闪色
        theme_color: '#0a0b0e',
        background_color: '#050608',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        icons: [
          { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,woff2}'],
        // API 响应不进预缓存。运行时缓存只负责弱网/离线回退，在线新鲜度仍由 API 与 TanStack Query 控制。
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            // Workbox 用完整 URL 匹配 RegExp；不能以 `/api` 开头，否则这条规则永远不会命中。
            urlPattern: /\/api\/funds\/search(?:\?|$)/,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'lookthru-fund-search',
              expiration: { maxEntries: 100, maxAgeSeconds: 60 * 60 * 24 },
            },
          },
          {
            urlPattern: /\/api\/funds\/\d{6}\/(?:detail|holdings|quotes)(?:\?|$)/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'lookthru-api',
              networkTimeoutSeconds: 2,
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
