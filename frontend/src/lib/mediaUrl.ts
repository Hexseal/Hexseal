/**
 * Convert a raw avatar/media URL to one that loads correctly in the browser.
 *
 * Avatars stored on our relay (ngrok tunnel) can't be loaded by the browser
 * directly — ngrok may show an interstitial HTML page instead of the image.
 * Route them through /api/media which fetches server-side with the bypass header.
 */

export function resolveMediaUrl(url: string | null | undefined): string | null {
  if (!url) return null;

  try {
    const parsed = new URL(url);

    // Localhost URLs (RELAYER_PUBLIC_URL not set on relayer): proxy server-side
    // so the browser doesn't try to reach localhost:3001 on another machine.
    if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
      const match = parsed.pathname.match(/^\/public\/(.+)$/);
      if (match) return `/api/media?key=${encodeURIComponent(match[1])}`;
    }

    // ngrok URLs: browser fetches directly with the query-param interstitial bypass.
    // Server-side proxying from Vercel to ngrok is blocked by ngrok's network rules,
    // but the query param works for direct browser requests.
    const relayerBase = process.env.NEXT_PUBLIC_RELAYER_URL ?? '';
    const isNgrok =
      parsed.hostname.endsWith('.ngrok-free.app') ||
      parsed.hostname.endsWith('.ngrok-free.dev') ||
      parsed.hostname.endsWith('.ngrok.io') ||
      parsed.hostname.endsWith('.ngrok.app');

    if (isNgrok && parsed.pathname.startsWith('/public/')) {
      return `${url}?ngrok-skip-browser-warning=true`;
    }

    // Non-ngrok public relayer (VPS in production): proxy through /api/media.
    if (relayerBase && url.startsWith(relayerBase)) {
      const match = parsed.pathname.match(/^\/public\/(.+)$/);
      if (match) return `/api/media?key=${encodeURIComponent(match[1])}`;
    }
  } catch {
    // Not a valid URL — return as-is
  }

  return url;
}
