import { now, observeClock, SYNC_TABLES, SYNCED_SETTINGS, type FintoDB, type Settings, type SyncTable } from '../db/schema';
import { creditOf, fixNegativeCredit, fixOverOffset, openPayables } from './ledger';

/**
 * Sync between browsers with "sync packages" (JSON files, optionally encrypted), no server needed.
 *
 * - Each browser has its own device id (meta table, not backed up / not synced).
 * - Every write gives the record a local sequence number _seq. For every synced browser we remember:
 *   · theirSeq — up to which number we have received their changes (sent in packages as an "ack");
 *   · ackedByThem — up to which number they have confirmed ours → the next package only contains newer changes.
 * - Merge per record: the newer updatedAt wins (ties are broken by content so every browser picks the same one).
 *   Deletes are soft, so they sync like any edit.
 * - After merging: merge categories / tags / people with the same name (each browser seeds its own defaults with different ids),
 *   then re-check the money rules (held money not negative, debts not over-repaid) and report what was fixed.
 */

export interface Device { id: string; name: string }
export interface PeerState {
  id: string;
  name: string;
  /** Received that browser's changes up to this number. */
  theirSeq: number;
  /** That browser confirmed receiving this browser's changes up to this number. */
  ackedByThem: number;
  lastIn?: { at: string; added: number; updated: number; total: number };
  /** _seq ranges written while importing that browser's own packages: not sent back to it (smaller packages). */
  echo?: [number, number][];
  lastOut?: { at: string; count: number; full: boolean };
}
type Row = Record<string, unknown> & { id: string; updatedAt: string };

export interface SyncPackage {
  app: 'hihand-finto';
  kind: 'sync';
  v: 1;
  from: Device;
  /** Which browser the package is for (null = full package, for a new browser / any browser). */
  to: string | null;
  createdAt: string;
  /** Contains the sender's changes with sequence numbers in (since, upto]. */
  since: number;
  upto: number;
  /** Up to which number the sender has received each other browser's changes. */
  acks: Record<string, number>;
  settings?: Partial<Settings> & { syncUpdatedAt?: string };
  tables: Partial<Record<SyncTable, Row[]>>;
}
export interface EncryptedPackage { app: 'hihand-finto'; kind: 'sync'; v: 1; encrypted: true; fromName: string; salt: string; iv: string; data: string }

export interface ImportReport {
  from: Device;
  added: number;
  updated: number;
  /** Records (soft-)deleted by the other browser, including duplicates it merged. */
  removed: number;
  skipped: number;
  perTable: Partial<Record<SyncTable, { added: number; updated: number }>>;
  settingsUpdated: boolean;
  /** What was fixed automatically after merging (same-name merges, removed rows that made held money negative…). */
  fixes: string[];
  /** Needs your review. */
  warnings: string[];
}

/* ---------- This browser and synced browsers ---------- */

export async function getDevice(db: FintoDB): Promise<Device> {
  const cur = (await db.meta.get('device'))?.value as Device | undefined;
  if (cur?.id) return cur;
  const id = crypto.randomUUID();
  const dev = { id, name: `Trình duyệt ${id.slice(0, 4).toUpperCase()}` };
  await db.meta.put({ key: 'device', value: dev });
  return dev;
}

export async function setDeviceName(db: FintoDB, name: string) {
  const n = name.trim().replace(/\s+/g, ' ');
  if (!n) throw new Error('Cần nhập tên máy');
  const dev = await getDevice(db);
  await db.meta.put({ key: 'device', value: { ...dev, name: n } });
}

export async function getPeers(db: FintoDB): Promise<Record<string, PeerState>> {
  return ((await db.meta.get('peers'))?.value as Record<string, PeerState> | undefined) ?? {};
}
const savePeers = (db: FintoDB, peers: Record<string, PeerState>) => db.meta.put({ key: 'peers', value: peers });

/** Forget a browser: the next package for it will be a full one. */
export async function forgetPeer(db: FintoDB, peerId: string) {
  const peers = await getPeers(db);
  delete peers[peerId];
  await savePeers(db, peers);
}

/** Records changed on this browser that the other one does not have yet (not acknowledged, excluding what came from it). */
export async function pendingFor(db: FintoDB, peerId: string | null) {
  const peer = peerId ? (await getPeers(db))[peerId] : undefined;
  const since = peer?.ackedByThem ?? 0;
  const echo = peer?.echo ?? [];
  let n = 0;
  for (const t of SYNC_TABLES) {
    const rows = (since ? await db.table(t).where('_seq').above(since).toArray() : await db.table(t).toArray()) as { _seq?: number }[];
    n += rows.filter((r) => !echo.some(([a, b]) => (r._seq ?? 0) > a && (r._seq ?? 0) <= b)).length;
  }
  return n;
}

/* ---------- Export ---------- */

const strip = (r: Record<string, unknown>) => {
  const { _seq: _s, ...rest } = r;
  return rest as Row;
};

/** Build a sync package: for a known browser (only unacknowledged changes) or a full package (to = null). */
export async function buildPackage(db: FintoDB, to: string | null): Promise<SyncPackage> {
  return db.transaction('rw', [...SYNC_TABLES.map((t) => db.table(t)), db.settings, db.meta], async () => {
    const from = await getDevice(db);
    const peers = await getPeers(db);
    const since = to ? peers[to]?.ackedByThem ?? 0 : 0;
    const tables: SyncPackage['tables'] = {};
    let count = 0;
    const echo = (to && peers[to]?.echo) || [];
    const fromThem = (r: { _seq?: number }) => echo.some(([a, b]) => (r._seq ?? 0) > a && (r._seq ?? 0) <= b);
    for (const t of SYNC_TABLES) {
      const all = since ? await db.table(t).where('_seq').above(since).toArray() : await db.table(t).toArray();
      const rows = all.filter((r) => !fromThem(r));
      if (rows.length) tables[t] = rows.map(strip);
      count += rows.length;
    }
    const s = await db.settings.get('settings');
    const settings = s ? Object.fromEntries([...SYNCED_SETTINGS, 'syncUpdatedAt'].filter((k) => k in s).map((k) => [k, s[k as keyof Settings]])) : undefined;
    const acks = Object.fromEntries(Object.values(peers).map((p) => [p.id, p.theirSeq]));
    if (to && peers[to]) {
      peers[to] = { ...peers[to], lastOut: { at: now(), count, full: since === 0 } };
      await savePeers(db, peers);
    }
    return { app: 'hihand-finto', kind: 'sync', v: 1, from, to, createdAt: now(), since, upto: db.seq, acks, settings, tables };
  });
}

/** Number of records in a package. */
export const packageSize = (p: SyncPackage) => Object.values(p.tables).reduce((a, rows) => a + (rows?.length ?? 0), 0);

/* ---------- Encryption (optional): PBKDF2 + AES-GCM ---------- */

const te = new TextEncoder();
const td = new TextDecoder();
const toB64 = (buf: ArrayBuffer | Uint8Array) => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(password: string, salt: Uint8Array) {
  const raw = await crypto.subtle.importKey('raw', te.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: salt as BufferSource, iterations: 200_000, hash: 'SHA-256' }, raw,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** Turn a package into file contents; encrypted when a password is given. */
export async function packageToText(pkg: SyncPackage, password?: string): Promise<string> {
  const json = JSON.stringify(pkg);
  if (!password) return json;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await deriveKey(password, salt), te.encode(json));
  const out: EncryptedPackage = { app: 'hihand-finto', kind: 'sync', v: 1, encrypted: true, fromName: pkg.from.name, salt: toB64(salt), iv: toB64(iv), data: toB64(data) };
  return JSON.stringify(out);
}

/** Read a package file: returns the package, or that a password is needed. */
export async function readPackage(text: string, password?: string): Promise<{ pkg: SyncPackage } | { needPassword: true; fromName: string }> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('File không đọc được (không phải JSON)');
  }
  const o = raw as Partial<EncryptedPackage & SyncPackage> & { tables?: unknown };
  if (!o || o.app !== 'hihand-finto') throw new Error('Không phải file của Hihand Finto');
  if (o.kind !== 'sync') throw new Error(o.tables ? 'Đây là file sao lưu, không phải gói đồng bộ. Dùng “Khôi phục” trong mục Chung & dữ liệu.' : 'Gói đồng bộ không hợp lệ');
  if (o.v !== 1) throw new Error('Gói đồng bộ từ phiên bản khác, hãy cập nhật app trên cả hai máy');
  if (o.encrypted) {
    if (!password) return { needPassword: true, fromName: o.fromName ?? '' };
    let json: string;
    try {
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(o.iv!) as BufferSource }, await deriveKey(password, fromB64(o.salt!)), fromB64(o.data!) as BufferSource);
      json = td.decode(plain);
    } catch {
      throw new Error('Sai mật khẩu đồng bộ (hoặc file bị hỏng)');
    }
    return readPackage(json);
  }
  validate(o as SyncPackage);
  return { pkg: o as SyncPackage };
}

function validate(p: SyncPackage) {
  if (!p.from?.id || typeof p.from.id !== 'string' || typeof p.tables !== 'object' || !p.tables) throw new Error('Gói đồng bộ không hợp lệ');
  for (const [t, rows] of Object.entries(p.tables)) {
    if (!(SYNC_TABLES as readonly string[]).includes(t)) throw new Error(`Gói có bảng lạ “${t}”`);
    if (!Array.isArray(rows) || rows.some((r) => !r || typeof r.id !== 'string' || typeof r.updatedAt !== 'string')) {
      throw new Error(`Bảng “${t}” trong gói có dòng không hợp lệ`);
    }
  }
}

/* ---------- Import + merge ---------- */

/** Stable content comparison (sorted keys) so two browsers always pick the same record when updatedAt ties. */
const stable = (r: Row) => JSON.stringify(Object.keys(r).sort().map((k) => [k, r[k]]));
/** > 0: record `a` wins. */
const newer = (a: Row, b: Row) => a.updatedAt.localeCompare(b.updatedAt) || stable(a).localeCompare(stable(b));

/** Merge a package into this ledger. Runs in one transaction: a failure halfway changes nothing. */
export async function importPackage(db: FintoDB, pkg: SyncPackage): Promise<ImportReport> {
  validate(pkg);
  return db.transaction('rw', [...SYNC_TABLES.map((t) => db.table(t)), db.settings, db.meta], async () => {
    const me = await getDevice(db);
    if (pkg.from.id === me.id) throw new Error('Đây là gói do chính trình duyệt này tạo ra');
    const report: ImportReport = { from: pkg.from, added: 0, updated: 0, removed: 0, skipped: 0, perTable: {}, settingsUpdated: false, fixes: [], warnings: [] };
    const touched = new Set<string>();
    const seq0 = db.seq;

    for (const t of SYNC_TABLES) {
      const rows = pkg.tables[t];
      if (!rows?.length) continue;
      const table = db.table(t);
      const stat = { added: 0, updated: 0 };
      for (const incoming of rows) {
        const row = strip(incoming);
        observeClock(row.updatedAt);
        const local = (await table.get(row.id)) as Row | undefined;
        if (!local) {
          await table.add(row);
          if (row.deletedAt) report.removed++;
          else stat.added++;
        } else if (newer(row, strip(local)) > 0) {
          await table.put(row);
          if (row.deletedAt && !local.deletedAt) report.removed++;
          else if (!row.deletedAt) stat.updated++;
        } else {
          report.skipped++;
          continue;
        }
        const pid = (row as { personId?: unknown }).personId;
        if (typeof pid === 'string') touched.add(pid);
      }
      if (stat.added || stat.updated) report.perTable[t] = stat;
      report.added += stat.added;
      report.updated += stat.updated;
    }

    // Records just taken from the sender: skip them next time we send to it (it already has them).
    const echo: [number, number] = [seq0, db.seq];

    // Shared settings: the later change wins.
    const inc = pkg.settings;
    const cur = await db.settings.get('settings');
    if (inc?.syncUpdatedAt && cur && (!cur.syncUpdatedAt || inc.syncUpdatedAt > cur.syncUpdatedAt)) {
      const patch = Object.fromEntries([...SYNCED_SETTINGS, 'syncUpdatedAt'].filter((k) => k in inc).map((k) => [k, inc[k as keyof Settings]]));
      await db.settings.update('settings', patch);
      report.settingsUpdated = true;
    }

    if (report.added || report.updated || report.removed) {
      report.fixes.push(...(await dedupe(db)));
      // Money rules after merging (e.g. both browsers applied the same held money).
      for (const pid of touched) {
        const name = ((await db.people.get(pid))?.name) ?? '?';
        const a = await fixNegativeCredit(db, pid);
        if (a) report.fixes.push(`${name}: gỡ ${a} khoản tự trừ vào tiền giữ vì tiền giữ bị âm sau khi gộp`);
        const b = await fixOverOffset(db, pid);
        if (b) report.fixes.push(`${name}: gỡ ${b} lần cấn trừ vì khoản nợ đã được trả ở máy khác`);
        if ((await creditOf(db, pid)) < 0) report.warnings.push(`${name}: tiền đang giữ đang âm — xem lại các lần trả lại / chi hộ`);
        if ((await openPayables(db, pid)).some((p) => p.remaining < 0)) report.warnings.push(`${name}: khoản bạn nợ bị trả vượt — xem lại sổ nợ`);
      }
    }

    // Remember how far we are synced with the sender.
    const peers = await getPeers(db);
    const p = peers[pkg.from.id] ?? { id: pkg.from.id, name: pkg.from.name, theirSeq: 0, ackedByThem: 0 };
    p.name = pkg.from.name;
    if (pkg.since <= p.theirSeq) p.theirSeq = Math.max(p.theirSeq, pkg.upto);
    else report.warnings.push(`Có gói trước đó từ “${pkg.from.name}” chưa được nhập. Lần sau máy đó gửi sẽ tự gửi lại phần còn thiếu.`);
    p.ackedByThem = Math.max(p.ackedByThem, pkg.acks?.[me.id] ?? 0);
    p.echo = [...(p.echo ?? []), echo].filter(([a, b]) => b > a && b > p.ackedByThem);
    p.lastIn = { at: now(), added: report.added, updated: report.updated, total: packageSize(pkg) };
    peers[p.id] = p;
    await savePeers(db, peers);
    await db.meta.put({ key: 'clock', value: now() });
    return report;
  });
}

/* ---------- De-duplicate after syncing ---------- */

type Live = { id: string; deletedAt?: string | null };
const alive = <T extends Live>(rows: T[]) => rows.filter((r) => !r.deletedAt);

/** Group by key; keep the smallest id per group (every browser picks the same). Returns a map duplicate id → kept id. */
function dupMap<T extends Live>(rows: T[], key: (r: T) => string) {
  const keep = new Map<string, string>();
  const map = new Map<string, string>();
  for (const r of [...rows].sort((a, b) => a.id.localeCompare(b.id))) {
    const k = key(r);
    const k0 = keep.get(k);
    if (k0) map.set(r.id, k0);
    else keep.set(k, r.id);
  }
  return map;
}

async function remap(db: FintoDB, table: SyncTable, field: string, map: Map<string, string>) {
  if (!map.size) return;
  const t = now();
  for (const r of alive((await db.table(table).toArray()) as (Live & Record<string, unknown>)[])) {
    const v = r[field];
    if (typeof v === 'string' && map.has(v)) await db.table(table).update(r.id, { [field]: map.get(v), updatedAt: t });
  }
}

async function softDelete(db: FintoDB, table: SyncTable, ids: Iterable<string>) {
  const t = now();
  for (const id of ids) await db.table(table).update(id, { deletedAt: t, updatedAt: t });
}

/** Remove duplicate link rows (same key pair), keeping the smallest id. */
async function dedupeLinks(db: FintoDB, table: SyncTable, key: (r: Record<string, unknown>) => string) {
  const rows = alive((await db.table(table).toArray()) as (Live & Record<string, unknown>)[]);
  const dups = dupMap(rows, key);
  await softDelete(db, table, dups.keys());
  return dups.size;
}

const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();

/**
 * Each browser seeds its own default categories / tags (and may add the same person) with different ids.
 * After merging: keep one per name, move every reference to the kept one, soft-delete the duplicates.
 */
async function dedupe(db: FintoDB): Promise<string[]> {
  const out: string[] = [];
  const people = dupMap(alive(await db.people.toArray()), (p) => norm(p.name));
  if (people.size) {
    for (const t of ['shares', 'settlements', 'allocations', 'incomes', 'payables', 'repayments', 'groupMembers', 'monthNotes'] as const) await remap(db, t, 'personId', people);
    await softDelete(db, 'people', people.keys());
    out.push(`Gộp ${people.size} người trùng tên`);
  }
  const tags = dupMap(alive(await db.tags.toArray()), (t) => norm(t.name));
  if (tags.size) {
    await remap(db, 'transactionTags', 'tagId', tags);
    await remap(db, 'categoryTags', 'tagId', tags);
    await softDelete(db, 'tags', tags.keys());
    out.push(`Gộp ${tags.size} tag trùng tên`);
  }
  const catRefs = async (map: Map<string, string>) => {
    await remap(db, 'categories', 'parentId', map);
    await remap(db, 'transactions', 'categoryId', map);
    await remap(db, 'incomes', 'categoryId', map);
    await remap(db, 'categoryTags', 'categoryId', map);
    await softDelete(db, 'categories', map.keys());
  };
  const roots = dupMap(alive(await db.categories.toArray()).filter((c) => !c.parentId), (c) => `${c.kind ?? 'expense'}|${norm(c.name)}`);
  if (roots.size) await catRefs(roots);
  const kids = dupMap(alive(await db.categories.toArray()).filter((c) => c.parentId), (c) => `${c.kind ?? 'expense'}|${c.parentId}|${norm(c.name)}`);
  if (kids.size) await catRefs(kids);
  if (roots.size + kids.size) out.push(`Gộp ${roots.size + kids.size} danh mục trùng tên`);
  const links = await dedupeLinks(db, 'categoryTags', (r) => `${r.categoryId}|${r.tagId}`)
    + await dedupeLinks(db, 'transactionTags', (r) => `${r.transactionId}|${r.tagId}`)
    + await dedupeLinks(db, 'groupMembers', (r) => `${r.groupId}|${r.personId}`)
    + await dedupeLinks(db, 'monthNotes', (r) => `${r.personId}|${r.month}`);
  if (links) out.push(`Bỏ ${links} liên kết trùng`);
  return out;
}

/** Suggested file name for a package. */
export function packageFileName(pkg: SyncPackage, toName?: string) {
  const slug = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
  return `finto-sync-${slug(pkg.from.name)}-${pkg.to ? 'cho-' + slug(toName ?? 'may-khac') : 'day-du'}-${pkg.createdAt.slice(0, 10)}.json`;
}
