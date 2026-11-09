import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { updateSession } from '@motherbase/ssr/middleware';

export async function proxy(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_MOTHERBASE_URL;
  const key = process.env.NEXT_PUBLIC_MOTHERBASE_KEY;
  if (!url || !key) return NextResponse.next();
  return updateSession(request, url, key);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
