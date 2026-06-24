import { defineConfig } from 'vite'

// ────────────────────────────────────────────────────────────────────────────
// HOW TO FIND THE REAL API ENDPOINTS:
// 1. Open https://www.thaiwater.net/water/dam/large in Chrome
// 2. F12 → Network tab → filter "Fetch/XHR"
// 3. Reload the page — look for requests that return JSON dam data
// 4. Copy the full URL and paste it as the `dam` value in API_ENDPOINTS below
//    (in flood_analysis.js)
//
// Same process for river level at https://www.oas.psu.ac.th/pbwatch/
// ────────────────────────────────────────────────────────────────────────────

export default defineConfig({
  server: {
    proxy: {
      // Proxy /api-thaiwater/* → https://www.thaiwater.net/*  (bypasses CORS)
      '/api-thaiwater': {
        target: 'https://www.thaiwater.net',
        changeOrigin: true,
        secure: true,
        rewrite: path => path.replace(/^\/api-thaiwater/, ''),
      },
      // Proxy /api-thaiwater-v3/* → https://api-v3.thaiwater.net/*  (real-time data API)
      // configure: strip Imperva Set-Cookie headers so browser never sees them
      '/api-thaiwater-v3': {
        target: 'https://api-v3.thaiwater.net',
        changeOrigin: true,
        secure: true,
        rewrite: path => path.replace(/^\/api-thaiwater-v3/, ''),
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            delete proxyRes.headers['set-cookie'];
          });
        },
      },
      // Proxy /api-rid/* → https://water.rid.go.th/*
      '/api-rid': {
        target: 'https://water.rid.go.th',
        changeOrigin: true,
        secure: true,
        rewrite: path => path.replace(/^\/api-rid/, ''),
      },
      // Proxy /api-psu/* → https://www.oas.psu.ac.th/*  (PSU Pattani Basin Watch)
      '/api-psu': {
        target: 'https://www.oas.psu.ac.th',
        changeOrigin: true,
        secure: true,
        rewrite: path => path.replace(/^\/api-psu/, ''),
      },
    },
  },
})
