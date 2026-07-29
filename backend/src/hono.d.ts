/// <reference types="hono" />

/// <reference types="hono" />

declare module 'hono' {
  interface ContextVariableMap {
    user: { id: string };
    auth: { authenticated: boolean };
    session: { authenticated: boolean; userId?: string };
  }
}

export {};
