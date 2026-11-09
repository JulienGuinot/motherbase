import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  trailingSlash: true,
  images: {
    unoptimized: true,
  },
  experimental: {
    // The SDK's realtime module pulls in socket.io-client, which isn't
    // Edge-runtime-safe — middleware needs the Node.js runtime instead.
    // Not yet in Next's own experimental types, hence the cast.
    nodeMiddleware: true,
  } as NextConfig['experimental'],
}

export default nextConfig
