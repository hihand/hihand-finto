import { RelayError, RELAY_MESSAGES, type Role, type Transport } from '../domain/relay';

/**
 * WebSocket connection to the sync relay (worker/ in this repo).
 * Production: wss://finto-sync.hihandlabs.online. `npm run dev` uses a local `wrangler dev` (ws://localhost:8787)
 * unless VITE_SYNC_URL is set (e.g. VITE_SYNC_URL=wss://finto-sync.hihandlabs.online npm run dev).
 */
export const SYNC_URL: string = import.meta.env.VITE_SYNC_URL || (import.meta.env.DEV ? 'ws://localhost:8787' : 'wss://finto-sync.hihandlabs.online');

/** Relay close codes → reasons (see worker/src/index.ts). */
const CLOSE_CODES: Record<number, string> = { 4001: 'left', 4002: 'busy', 4004: 'gone', 4008: 'expired', 4009: 'too-large' };
/** Wait while more than this is queued in the socket (keeps memory flat and progress honest on slow networks). */
const HIGH_WATER = 1024 * 1024;

export interface RelayConnection extends Transport {
  /** Resolves when the other device joined the room; rejects with a RelayError if the room fails first. */
  paired: Promise<void>;
}

export function connectRelay(room: string, role: Role): RelayConnection {
  const ws = new WebSocket(`${SYNC_URL}/room/${room}?role=${role}`);
  ws.binaryType = 'arraybuffer';
  const early: Uint8Array[] = [];
  let onFrame: ((f: Uint8Array) => void) | null = null;
  let onClose: ((code: string) => void) | null = null;
  let ended: string | null = null;
  let opened = false;
  let isPaired = false;
  let pairedOk: () => void = () => {};
  let pairedFail: (e: RelayError) => void = () => {};
  const paired = new Promise<void>((res, rej) => { pairedOk = res; pairedFail = rej; });
  paired.catch(() => {}); // callers that never await it should not see an unhandled rejection
  const ping = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send('ping'); }, 25_000);

  const end = (code: string) => {
    if (ended) return;
    ended = code;
    clearInterval(ping);
    if (!isPaired) pairedFail(new RelayError(RELAY_MESSAGES[code] ?? RELAY_MESSAGES.network, code));
    onClose?.(code);
    try { ws.close(); } catch { /* ignore */ }
  };

  ws.addEventListener('open', () => { opened = true; });
  ws.addEventListener('message', (e) => {
    if (typeof e.data === 'string') {
      if (e.data === 'pong') return;
      let m: { relay?: string; code?: string };
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.relay === 'paired') { isPaired = true; pairedOk(); }
      // The relay announces errors before closing; treat them as final even if its close frame never arrives.
      else if (m.relay === 'left') end('left');
      else if (m.relay === 'error') end(m.code ?? 'left');
      return;
    }
    const f = new Uint8Array(e.data as ArrayBuffer);
    if (onFrame) onFrame(f);
    else early.push(f);
  });
  ws.addEventListener('close', (e) => end(CLOSE_CODES[e.code] ?? (opened ? 'left' : 'network')));

  return {
    paired,
    async send(frame) {
      if (ended) throw new RelayError(RELAY_MESSAGES[ended] ?? RELAY_MESSAGES.left, ended);
      ws.send(frame as Uint8Array<ArrayBuffer>);
      while (ws.bufferedAmount > HIGH_WATER && !ended) await new Promise((r) => setTimeout(r, 30));
    },
    listen(f, c) {
      onFrame = f;
      onClose = c;
      early.splice(0).forEach(f);
      if (ended) c(ended);
    },
    close() {
      if (!ended) {
        ended = 'cancelled';
        clearInterval(ping);
        pairedFail(new RelayError(RELAY_MESSAGES.cancelled, 'cancelled'));
        onClose?.('cancelled');
      }
      try { ws.close(1000); } catch { /* ignore */ }
    },
  };
}
