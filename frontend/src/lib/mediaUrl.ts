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
    // Only proxy our own relay URLs (ngrok or custom domain relayer)
    const relayerBase = process.env.NEXT_PUBLIC_RELAYER_URL ?? '';
    if (relayerBase && url.startsWith(relayerBase)) {
      // Extract filename from /public/<key>
      const match = parsed.pathname.match(/^\/public\/(.+)$/);
      if (match) return `/api/media?key=${encodeURIComponent(match[1])}`;
    }
    // Fallback: detect any ngrok domain
    if (parsed.hostname.endsWith('.ngrok-free.app') ||
        parsed.hostname.endsWith('.ngrok-free.dev') ||
        parsed.hostname.endsWith('.ngrok.io')) {
      const match = parsed.pathname.match(/^\/public\/(.+)$/);
      if (match) return `/api/media?key=${encodeURIComponent(match[1])}`;
    }
  } catch {
    // Not a valid URL — return as-is
  }

  return url;
}
