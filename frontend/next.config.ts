import type { NextConfig } from "next";

/**
 * Номер этой сборки. Считается ОДИН РАЗ на сборку и подставляется В КОД (поле
 * `env` ниже) — и в страницу, и в обработчик `/api/version`. Оба читают одну и ту
 * же вкомпилированную строку, поэтому перезапуск сервера её не меняет.
 *
 * ⚠️ ЭТО ГЛАВНОЕ ТРЕБОВАНИЕ К НЕЙ. Если номер на сервере начнёт считаться заново
 * при каждом запуске, он разойдётся с номером страницы у ВСЕХ, страница увидит
 * разницу и пойдёт перезагружаться — получится не «работает старый код», а «не
 * работает ничего». Вторая защита от петли (одна попытка на версию) —
 * `src/lib/appVersion.ts`.
 *
 * `BUILD_ID` из окружения — чтобы развёртывание могло подставить хеш коммита;
 * иначе время сборки, которое тоже уникально на сборку.
 */
const BUILD_ID = process.env.BUILD_ID || `b${Date.now().toString(36)}`;

const nextConfig: NextConfig = {
  generateBuildId: () => BUILD_ID,

  reactStrictMode: true,

  // pino (WalletConnect dep) dynamically requires pino-pretty — don't bundle it
  serverExternalPackages: ['pino', 'pino-pretty'],

  // Ключ `eslint` убран при переезде на Next 16: там его больше нет в типе
  // NextConfig (проверку кода из сборки вынесли наружу целиком).

  images: {
    domains: ['ipfs.io', 'w3s.link', 'cloudflare-ipfs.com'],
    formats: ['image/avif', 'image/webp'],
    deviceSizes: [640, 750, 828, 1080, 1200, 1920, 2048, 3840],
    imageSizes: [16, 32, 48, 64, 96, 128, 256, 384],
  },

  output: 'standalone',

  experimental: {
    serverActions: {
      bodySizeLimit: '100mb',
    },
    optimizePackageImports: [
      '@rainbow-me/rainbowkit',
      'wagmi',
      'viem',
      '@tanstack/react-query',
    ],
  },

  webpack: (config, { isServer }) => {
    // Required for @xmtp/browser-sdk (WASM-based MLS group messaging)
    config.experiments = {
      ...config.experiments,
      asyncWebAssembly: true,
      layers: true,
    };

    if (isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        net: false,
        tls: false,
        dns: false,
        child_process: false,
      };
    }

    return config;
  },

  env: {
    NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID,
    NEXT_PUBLIC_VAPID_PUBLIC_KEY: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
    // Один и тот же номер уезжает и в страницу, и в `/api/version` — см. врезку
    // у `BUILD_ID` выше.
    NEXT_PUBLIC_BUILD_ID: BUILD_ID,
  },

  productionBrowserSourceMaps: false,

  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-XSS-Protection', value: '1; mode=block' },
        ],
      },
    ];
  },
};

export default nextConfig;
