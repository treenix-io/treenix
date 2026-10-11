import type { IncomingMessage, ServerResponse } from 'node:http'
import { assertSafePath } from '#core/path'
import { KernelError } from '#errors'
import type { Session } from '#kernel/types'

/** A route owns consumption of its Session lane; the binding owns its lifetime. */
export type TwpHttpHandler = (request: IncomingMessage, response: ServerResponse, session: Session) => Promise<void>

export interface RegisteredRoute {
  readonly handler: TwpHttpHandler
  readonly signal: AbortSignal
  readonly controller: AbortController
}

/** Keeps module routes within one HTTP binding and retires their active sessions. */
export function createTwpHttpRoutes() {
  const routes = new Map<string, RegisteredRoute>()
  let bound = false
  let closed = false

  return {
    /** Returns a disposer for exactly this registration, including its in-flight requests. */
    register(path: string, handler: TwpHttpHandler): () => void {
      if (closed) throw new KernelError('UNAVAILABLE', 'HTTP routes are closed')
      assertSafePath(path)
      if (path === '/twp' || path.startsWith('/twp/') || path === '/auth' || path.startsWith('/auth/'))
        throw new KernelError('CONFLICT', 'The HTTP binding owns this route')
      if (routes.has(path)) throw new KernelError('CONFLICT', 'HTTP route is already registered')

      const controller = new AbortController()
      const route = { handler, signal: controller.signal, controller }
      routes.set(path, route)

      return () => {
        if (routes.get(path) !== route) return
        routes.delete(path)
        controller.abort(new KernelError('CANCELLED', 'HTTP route retired'))
      }
    },
    /** A route table has one server owner; separate instances use separate tables. */
    bind() {
      if (bound || closed) throw new KernelError('CONFLICT', 'HTTP routes already have an owner')
      bound = true

      return {
        get(path: string): RegisteredRoute | undefined { return routes.get(path) },
        close(): void {
          if (closed) return
          closed = true
          for (const route of routes.values())
            route.controller.abort(new KernelError('CANCELLED', 'HTTP binding closed'))
          routes.clear()
        },
      }
    },
  }
}

export type TwpHttpRoutes = ReturnType<typeof createTwpHttpRoutes>


declare module '#kernel/manifest' {
  interface NativeModuleHost {
    readonly httpRoutes?: TwpHttpRoutes;
  }
}
