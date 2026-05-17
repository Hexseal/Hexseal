import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Skip flash: if the user was previously connected (cookie set by wagmi client),
  // redirect them straight to /board before the home page ever renders.
  if (pathname === '/') {
    if (request.cookies.get('has-wallet')?.value === '1') {
      return NextResponse.redirect(new URL('/board', request.url));
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/', '/dashboard/:path*', '/admin/:path*'],
};
