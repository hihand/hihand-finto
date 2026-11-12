import { gunzipSync, gzipSync } from 'fflate';
import type { FintoDB } from '../db/schema';
import { buildPackage, getDevice, importPackage, packageSize, readPackage, recordAck, recordSent, type Device, type ImportReport } from './sync';

/**
 * Live sync between two browsers through a relay (QR code / link), on top of the sync packages in sync.ts.
 *
 * The QR code carries a one-time 256-bit key. The relay room id is derived from it (SHA-256), so the relay never
 * learns the key, and every frame is AES-GCM encrypted with it. The additional data binds each frame to its sender
 * and position, so the relay can not reflect, reorder or replay frames without the receiver noticing.
 *
 * Session (sequential, so both ledgers end identical — including what the merge fixes on the guest):
 *   both  → hello {proto, schema, device}
 *   host  → package (gzip, split into chunks)       guest merges it
 *   guest → package (what the host is missing)      host merges it
 *   host  → ack {upto}                              guest records that the host has its changes
 *   guest → done                                    both finish
 * A package is merged only once all of its chunks arrived; a broken session merges nothing partial,
 * and what was not acknowledged is simply sent again next time.
 */

export const PROTO = 1;
/** Plain bytes per chunk (each chunk is one WebSocket message). */
export const CHUNK = 256 * 1024;

export type Role = 'host' | 'guest';

/** A connection to the other device (WebSocket through the relay, or an in-memory pair in tests). */
export interface Transport {
  /** May wait for the outgoing buffer to drain (backpressure). */
  send(frame: Uint8Array): void | Promise<void>;
  /** Frames that arrive before listen() is called are kept and delivered then. `code` says why the connection ended. */
  listen(onFrame: (frame: Uint8Array) => void, onClose: (code: string) => void): void;
  close(): void;
}

export interface Progress {
  step: 'hello' | 'sending' | 'receiving' | 'merging' | 'done';
  peer?: Device;
  /** Chunks sent / received so far, out of `total`. */
  done?: number;
  total?: number;
}

export interface RelayResult {
  peer: Device;
  /** Records sent to the other device. */
  sent: number;
  /** The package sent was a full one (first sync with that device). */
  full: boolean;
  report: ImportReport;
}

export class RelayError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

/** Messages for the ways a session can end early (close codes from the relay, local checks). */
export const RELAY_MESSAGES: Record<string, string> = {
  key: 'Mã QR không khớp với máy kia (có thể đã quét mã cũ). Tạo mã mới rồi quét lại.',
  version: 'Hai máy đang chạy phiên bản app khác nhau. Bấm “Tải lại” để cập nhật app trên cả hai máy rồi thử lại.',
  self: 'Đây là chính trình duyệt này. Hãy quét mã trên một máy (hoặc trình duyệt) khác.',
  left: 'Máy kia đã ngắt kết nối giữa chừng. Phần chưa nhận đủ không được gộp — thử lại để hoàn tất.',
  expired: 'Mã QR đã hết hạn. Tạo mã mới để đồng bộ.',
  gone: 'Mã này không còn dùng được (đã hết hạn hoặc máy kia đã đóng). Tạo mã mới ở máy kia.',
  busy: 'Mã này đang được một máy khác dùng. Tạo mã mới.',
  'too-large': 'Dữ liệu quá lớn để gửi qua một phiên đồng bộ. Dùng “File thủ công” trong mục Nâng cao.',
  network: 'Không kết nối được máy chủ đồng bộ. Kiểm tra mạng rồi thử lại.',
  protocol: 'Máy kia gửi dữ liệu không hợp lệ. Thử lại.',
  cancelled: 'Đã hủy.',
};
const fail = (code: string, detail?: string) => new RelayError(detail ?? RELAY_MESSAGES[code] ?? RELAY_MESSAGES.left, code);

/* ---------- Invite: key ↔ link ↔ room ---------- */

const te = new TextEncoder();
const td = new TextDecoder();
export const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

/** A new one-time key (32 random bytes). */
export const newKey = () => crypto.getRandomValues(new Uint8Array(32));

/** Link shown as QR code / copied for another computer. The key is in the fragment: browsers never send it to a server. */
export const inviteLink = (origin: string, key: Uint8Array) => `${origin.replace(/\/$/, '')}/#sync=${b64url(key)}`;

/** Read the key from a scanned / pasted link (or just the `sync=…` part). */
export function parseInvite(text: string): Uint8Array | null {
  const m = text.trim().match(/(?:^|[#&?\s])sync=([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/);
  return m ? fromB64url(m[1]) : null;
}

/** Relay room id derived from the key (16 bytes of SHA-256, base64url = 22 chars). */
export async function roomOf(key: Uint8Array): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', new Uint8Array([...te.encode('hihand-finto-room:'), ...key]));
  return b64url(new Uint8Array(h).slice(0, 16));
}

/* ---------- Frames ---------- */

const T_JSON = 1;
const T_CHUNK = 2;

type Msg =
  | { t: 'hello'; proto: number; schema: number; device: Device }
  | { t: 'ack'; upto: number }
  | { t: 'done' }
  | { t: 'error'; message: string; code?: string };

async function makeCipher(keyBytes: Uint8Array, role: Role) {
  const key = await crypto.subtle.importKey('raw', keyBytes as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
  const other: Role = role === 'host' ? 'guest' : 'host';
  let out = 0;
  let inn = 0;
  return {
    async seal(plain: Uint8Array) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(`${role}:${out++}`) }, key, plain as BufferSource));
      const f = new Uint8Array(12 + ct.length);
      f.set(iv);
      f.set(ct, 12);
      return f;
    },
    async open(frame: Uint8Array) {
      try {
        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: frame.subarray(0, 12) as BufferSource, additionalData: te.encode(`${other}:${inn}`) }, key, frame.subarray(12) as BufferSource);
        inn++;
        return new Uint8Array(plain);
      } catch {
        throw fail('key');
      }
    },
  };
}

const jsonFrame = (m: Msg) => {
  const b = te.encode(JSON.stringify(m));
  const f = new Uint8Array(1 + b.length);
  f[0] = T_JSON;
  f.set(b, 1);
  return f;
};
const chunkFrame = (index: number, total: number, data: Uint8Array) => {
  const f = new Uint8Array(9 + data.length);
  const v = new DataView(f.buffer);
  f[0] = T_CHUNK;
  v.setUint32(1, index);
  v.setUint32(5, total);
  f.set(data, 9);
  return f;
};

/* ---------- Session ---------- */

export interface RunOptions {
  onProgress?: (p: Progress) => void;
  /** Chunk size override (tests). */
  chunk?: number;
  /** Schema version announced in hello (tests: simulate an older app). */
  schema?: number;
}

/** Run one sync session over a paired connection. Resolves when both sides merged each other's changes. */
export async function runSync(db: FintoDB, transport: Transport, key: Uint8Array, role: Role, opts: RunOptions = {}): Promise<RelayResult> {
  const me = await getDevice(db);
  const cipher = await makeCipher(key, role);
  const progress = opts.onProgress ?? (() => {});
  const chunkSize = opts.chunk ?? CHUNK;
  const schema = opts.schema ?? db.verno;

  return new Promise<RelayResult>((resolve, reject) => {
    let finished = false;
    let peer: Device | undefined;
    let sent: { count: number; full: boolean } | undefined;
    let report: ImportReport | undefined;
    let parts: Uint8Array[] = [];
    let chain = Promise.resolve();

    const send = async (plain: Uint8Array) => transport.send(await cipher.seal(plain));
    const finish = () => {
      if (finished) return;
      finished = true;
      progress({ step: 'done', peer });
      resolve({ peer: peer!, sent: sent!.count, full: sent!.full, report: report! });
    };
    const abort = async (e: unknown) => {
      if (finished) return;
      finished = true;
      const err = e instanceof RelayError ? e : new RelayError(e instanceof Error ? e.message : String(e), 'local');
      // Tell the other side why (best effort; useless when the key is wrong).
      if (err.code !== 'key' && err.code !== 'left' && err.code !== 'peer') {
        try { await send(jsonFrame({ t: 'error', message: err.message, code: err.code })); } catch { /* closed */ }
      }
      transport.close();
      reject(err);
    };

    const sendPackage = async () => {
      const pkg = await buildPackage(db, peer!.id);
      sent = { count: packageSize(pkg), full: pkg.since === 0 };
      await recordSent(db, peer!, sent.count, sent.full);
      const bytes = gzipSync(te.encode(JSON.stringify(pkg)), { level: 6 });
      const total = Math.max(1, Math.ceil(bytes.length / chunkSize));
      for (let i = 0; i < total; i++) {
        progress({ step: 'sending', peer, done: i, total });
        await send(chunkFrame(i, total, bytes.subarray(i * chunkSize, (i + 1) * chunkSize)));
      }
      progress({ step: 'sending', peer, done: total, total });
    };

    const receivePackage = async () => {
      progress({ step: 'merging', peer });
      const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let at = 0;
      for (const p of parts) { all.set(p, at); at += p.length; }
      parts = [];
      let text: string;
      try { text = td.decode(gunzipSync(all)); } catch { throw fail('protocol'); }
      const read = await readPackage(text);
      if (!('pkg' in read) || read.pkg.from.id !== peer!.id) throw fail('protocol');
      report = await importPackage(db, read.pkg);
      return read.pkg.upto;
    };

    const handle = async (frame: Uint8Array) => {
      if (finished) return;
      const plain = await cipher.open(frame);
      if (plain[0] === T_JSON) {
        let m: Msg;
        try { m = JSON.parse(td.decode(plain.subarray(1))) as Msg; } catch { throw fail('protocol'); }
        if (m.t === 'error') throw new RelayError(m.message, 'peer');
        if (m.t === 'hello') {
          if (m.proto !== PROTO || m.schema !== schema) throw fail('version');
          if (!m.device?.id) throw fail('protocol');
          if (m.device.id === me.id) throw fail('self');
          peer = m.device;
          progress({ step: 'hello', peer });
          if (role === 'host') await sendPackage();
          return;
        }
        if (!peer) throw fail('protocol');
        if (m.t === 'ack' && role === 'guest' && report) {
          await recordAck(db, peer.id, m.upto);
          await send(jsonFrame({ t: 'done' }));
          finish();
          return;
        }
        if (m.t === 'done' && role === 'host' && report) {
          finish();
          return;
        }
        throw fail('protocol');
      }
      if (plain[0] === T_CHUNK && peer && !report) {
        const v = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);
        const index = v.getUint32(1);
        const total = v.getUint32(5);
        if (index !== parts.length || total < 1) throw fail('protocol');
        parts.push(plain.slice(9));
        progress({ step: 'receiving', peer, done: parts.length, total });
        if (parts.length < total) return;
        const upto = await receivePackage();
        if (role === 'guest') await sendPackage();
        else await send(jsonFrame({ t: 'ack', upto }));
        return;
      }
      throw fail('protocol');
    };

    transport.listen(
      (frame) => { chain = chain.then(() => handle(frame)).catch(abort); },
      (code) => { chain = chain.then(() => abort(fail(code))); },
    );
    chain = chain.then(() => send(jsonFrame({ t: 'hello', proto: PROTO, schema, device: me }))).catch(abort);
  });
}
