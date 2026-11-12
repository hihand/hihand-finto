import { DurableObject } from 'cloudflare:workers';

/**
 * Hihand Finto sync relay.
 *
 * Two devices meet in a "room" (one Durable Object per room id) and the room forwards binary frames between them.
 * Frames are encrypted end to end with a one-time key that only travels inside the QR code / link fragment,
 * so the relay never sees ledger data in clear. Nothing is written to storage except the room's expiry alarm.
 *
 * Client protocol:
 *   GET /room/<id>?role=host|guest  (WebSocket upgrade)
 *   - binary frames: forwarded to the other device as is;
 *   - text "ping": answered with "pong" (keeps the connection alive while waiting for a scan);
 *   - text frames from the relay: JSON {"relay": "paired" | "left" | "error", "code"?: string}.
 * The host opens the room and waits for one guest; a guest can only join an existing room.
 * The room closes when either side leaves, after WAIT_MS without a guest, after SESSION_MS in total, or past MAX_BYTES.
 */

export interface Env {
  ROOMS: DurableObjectNamespace<Room>;
  ALLOWED_ORIGINS?: string;
  /** Test override for WAIT_MS, in seconds. */
  WAIT_SECONDS?: string;
}

type Role = 'host' | 'guest';
/** Kept on each socket (survives hibernation): role, bytes sent, when the room / session expires. */
interface Attachment { role: Role; bytes: number; until: number }

/** Time a host waits for the QR to be scanned (matches the countdown shown in the app). */
const WAIT_MS = 5 * 60_000;
/** Hard limit for one sync session once paired. */
const SESSION_MS = 15 * 60_000;
/** Bytes a room may relay in total (both directions): a full 5-year ledger is well below 20 MB compressed. */
const MAX_BYTES = 64 * 1024 * 1024;
/** 16 random bytes, base64url. */
const ROOM_ID = /^[A-Za-z0-9_-]{22}$/;

/** Close codes (4000–4999 are free for applications; the app maps them to messages). */
export const CLOSE = { left: 4001, busy: 4002, gone: 4004, expired: 4008, tooLarge: 4009 } as const;

const allowedOrigin = (origin: string | null, env: Env) => {
  if (!origin) return false;
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  return (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean).includes(origin);
};

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/' || url.pathname === '/health') return new Response('finto-sync ok\n', { headers: { 'content-type': 'text/plain' } });
    const m = url.pathname.match(/^\/room\/([^/]+)$/);
    if (!m) return new Response('Not found', { status: 404 });
    if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
    if (!allowedOrigin(req.headers.get('Origin'), env)) return new Response('Origin not allowed', { status: 403 });
    const role = url.searchParams.get('role');
    if (!ROOM_ID.test(m[1]) || (role !== 'host' && role !== 'guest')) return new Response('Bad request', { status: 400 });
    return env.ROOMS.get(env.ROOMS.idFromName(m[1])).fetch(req);
  },
} satisfies ExportedHandler<Env>;

export class Room extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Answered by the runtime without waking the object (WebSocket hibernation).
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(req: Request): Promise<Response> {
    const role = new URL(req.url).searchParams.get('role') as Role;
    const [client, server] = Object.values(new WebSocketPair());
    const hasHost = this.ctx.getWebSockets('host').length > 0;
    const hasGuest = this.ctx.getWebSockets('guest').length > 0;
    // Refusals are sent over an accepted socket so the browser can read the close code.
    const refuse = (code: number, reason: string) => {
      server.accept();
      server.send(JSON.stringify({ relay: 'error', code: reason }));
      server.close(code, reason);
      return new Response(null, { status: 101, webSocket: client });
    };
    if (role === 'host' && (hasHost || hasGuest)) return refuse(CLOSE.busy, 'busy');
    const host = this.ctx.getWebSockets('host')[0]?.deserializeAttachment() as Attachment | undefined;
    if (role === 'guest' && (!hasHost || !host || host.until < Date.now())) return refuse(CLOSE.gone, 'gone');
    if (role === 'guest' && hasGuest) return refuse(CLOSE.busy, 'busy');

    const until = Date.now() + (role === 'host' ? Number(this.env.WAIT_SECONDS) * 1000 || WAIT_MS : SESSION_MS);
    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({ role, bytes: 0, until } satisfies Attachment);
    await this.ctx.storage.setAlarm(until);
    if (role === 'guest') {
      // The session limit now applies to both sockets.
      const h = this.ctx.getWebSockets('host')[0];
      h.serializeAttachment({ ...host!, until });
      const paired = JSON.stringify({ relay: 'paired' });
      for (const ws of this.ctx.getWebSockets()) ws.send(paired);
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer) {
    if (typeof msg === 'string') return; // only "ping" is expected (auto-answered); ignore anything else
    const a = ws.deserializeAttachment() as Attachment;
    if (a.until < Date.now()) return this.end(CLOSE.expired, 'expired');
    a.bytes += msg.byteLength;
    ws.serializeAttachment(a);
    const total = this.ctx.getWebSockets().reduce((n, s) => n + ((s.deserializeAttachment() as Attachment | null)?.bytes ?? 0), 0);
    if (total > MAX_BYTES) return this.end(CLOSE.tooLarge, 'too-large');
    const other = this.ctx.getWebSockets(a.role === 'host' ? 'guest' : 'host')[0];
    other?.send(msg);
  }

  async webSocketClose(ws: WebSocket) {
    try { ws.close(1000, 'bye'); } catch { /* already closed */ }
    const rest = this.ctx.getWebSockets().filter((s) => s !== ws);
    for (const s of rest) {
      try {
        s.send(JSON.stringify({ relay: 'left' }));
        s.close(CLOSE.left, 'left');
      } catch { /* already closed */ }
    }
    await this.clear();
  }

  async webSocketError(ws: WebSocket) {
    await this.webSocketClose(ws);
  }

  /**
   * Expiry. Clients also treat {"relay":"error"} as final and close themselves (and run their own countdown),
   * and a late guest is refused by the `until` check, so a close frame that does not get through is harmless.
   */
  async alarm() {
    await this.end(CLOSE.expired, 'expired');
  }

  private async end(code: number, reason: string) {
    for (const s of this.ctx.getWebSockets()) {
      try {
        s.send(JSON.stringify({ relay: 'error', code: reason }));
        s.close(code, reason);
      } catch { /* already closed */ }
    }
    await this.clear();
  }

  private async clear() {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}
