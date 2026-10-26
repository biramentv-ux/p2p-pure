/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

/**
 * Content-Security-Policy for the production build only (the dev server injects inline
 * scripts for hot reload, which a strict policy would block). A <meta> policy cannot set
 * frame-ancestors or report-uri; those need response headers at the host.
 */
function contentSecurityPolicy(): Plugin {
  let inviteOrigin = 'https://tg.dyrakarmy.online'
  return {
    name: 'csp-meta',
    apply: 'build',
    configResolved(config) {
      const env = loadEnv(config.mode, config.envDir ?? process.cwd(), 'VITE_')
      if (env.VITE_INVITE_API) inviteOrigin = new URL(env.VITE_INVITE_API).origin
    },
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        const policy = [
          "default-src 'self'",
          "script-src 'self'",
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: blob:",
          "font-src 'self' data:",
          // Demo signalling also uses a WebSocket to the same host (wss:// or ws://).
          `connect-src 'self' ${inviteOrigin} ${inviteOrigin.replace(/^http/, 'ws')}`,
          "worker-src 'self'",
          "manifest-src 'self'",
          "media-src 'self' blob:",
          "object-src 'none'",
          "base-uri 'self'",
          "form-action 'self'",
        ].join('; ')
        return html.replace(
          '<head>',
          `<head>\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`,
        )
      },
    },
  }
}

/**
 * Response headers for `vite preview` (the origin the tunnel serves) and `vite dev`.
 * The meta CSP above cannot set frame-ancestors, so it is sent as a header here too.
 * Camera and microphone stay allowed for this origin only (QR scanner, calls); location
 * is allowed only for the app's own origin; everything else is switched off.
 */
export const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': "frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(self), microphone=(self), geolocation=(self), payment=(), usb=(), serial=(), bluetooth=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
}

// https://vite.dev/config/
export default defineConfig({
  server: { headers: SECURITY_HEADERS },
  preview: { headers: SECURITY_HEADERS },
  plugins: [
    react(),
    contentSecurityPolicy(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/*.png'],
      manifest: {
        name: 'P2P Secure Messenger',
        short_name: 'P2P Msgr',
        description: 'Decentralized, end-to-end encrypted P2P messenger. No servers, no cloud.',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        start_url: '/',
        icons: [
          {
            src: 'icons/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: 'icons/icon-512-maskable.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // App shell only in MVP — no network caching strategy for P2P
        // traffic (WebRTC data channels bypass the service worker anyway).
        globPatterns: ['**/*.{js,css,html,svg,png,ico}'],
      },
    }),
  ],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/identity/**/*.ts'],
    },
  },
})
