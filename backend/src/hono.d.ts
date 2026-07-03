/// <reference types="hono" />

declare module 'hono' {
  interface ContextVariableMap {
    user: { id: string };
    auth: { authenticated: boolean };
  }
}

export {};
