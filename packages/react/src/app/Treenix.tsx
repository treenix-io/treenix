import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { enablePatches } from 'immer'
import { type ReactNode } from 'react'
import { App } from './App'
import '#tree/load-client'
import { Toaster } from '#components/ui/sonner'
// CSS must be imported by the consumer: import '@treenx/react/root.css'

enablePatches()

const queryClient = new QueryClient()

export interface TreenixProps {
  /** Override initial path */
  path?: string
  /** Wrap with custom providers */
  children?: ReactNode
}

/**
 * Treenix as a single React component.
 * Includes all providers, auth, SSE, cache.
 */
export function Treenix({ children }: TreenixProps) {
  return (
    <QueryClientProvider client={queryClient}>
      <App />
      <Toaster />
      {children}
    </QueryClientProvider>
  )
}
