/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Sync relay WebSocket base URL, e.g. wss://finto-sync.hihandlabs.online (see src/lib/relaySocket.ts). */
  readonly VITE_SYNC_URL?: string;
}
