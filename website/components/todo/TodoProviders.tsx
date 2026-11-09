'use client'

import type { ReactNode } from 'react'
import { MotherbaseProvider } from '@motherbase/ui'
import { getBrowserClient } from '@/lib/motherbase/browser'

/** Client boundary: a client instance can't cross from a Server Component, so it's created here. */
export function TodoProviders({ children }: { children: ReactNode }) {
  return <MotherbaseProvider client={getBrowserClient()}>{children}</MotherbaseProvider>
}
