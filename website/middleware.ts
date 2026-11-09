import { updateSession } from '@motherbase/ssr'
import type { NextRequest } from 'next/server'

export async function middleware(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_MOTHERBASE_URL
  if (!url) return

  return updateSession(request, url)
}

export const config = {
  runtime: 'nodejs',
  matcher: ['/example/:path*'],
}
