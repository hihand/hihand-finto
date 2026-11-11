import { now, observeClock, SYNC_TABLES, SYNCED_SETTINGS, type FintoDB, type Settings, type SyncTable } from '../db/schema';
import { creditOf, fixNegativeCredit, fixOverOffset, openPayables } from './ledger';

/**
 * Đồng bộ giữa các trình duyệt bằng "gói đồng bộ" (file JSON, có thể mã hóa), không cần máy chủ.
 *
 * - Mỗi trình duyệt có một mã máy riêng (bảng meta, không sao lưu / không đồng bộ).
 * - Mỗi lần ghi, bản ghi nhận một số thứ tự _seq của máy này. Với mỗi máy đã đồng bộ, ta nhớ:
 *   · theirSeq — đã nhận các thay đổi của họ tới số nào (gửi kèm trong gói như "xác nhận");
 *   · ackedByThem — họ đã xác nhận nhận các thay đổi của ta tới số nào → gói sau chỉ chứa phần mới hơn.
 * - Gộp theo từng bản ghi: bản có updatedAt mới hơn thắng (bằng nhau thì so nội dung để mọi máy chọn giống nhau).
 *   Xóa là xóa mềm nên cũng đồng bộ như một lần sửa.
 * - Sau khi gộp: gộp danh mục / tag / người trùng tên (mỗi trình duyệt tự tạo danh mục mặc định với mã khác nhau),
 *   rồi kiểm tra lại các quy tắc tiền (tiền giữ không âm, khoản nợ không bị trả vượt) và báo những gì đã tự sửa.
 */

export interface Device { id: string; name: string }
export interface PeerState {
  id: string;
  name: string;
  /** Đã nhận thay đổi của máy đó tới số này. */
  theirSeq: number;
  /** Máy đó đã xác nhận nhận thay đổi của máy này tới số này. */
  ackedByThem: number;
  lastIn?: { at: string; added: number; updated: number; total: number };
  /** Các khoảng _seq đã ghi khi nhập gói của chính máy đó: không gửi ngược lại cho họ (gói gọn hơn). */
  echo?: [number, number][];
  lastOut?: { at: string; count: number; full: boolean };
}
type Row = Record<string, unknown> & { id: string; updatedAt: string };

export interface SyncPackage {
  app: 'hihand-finto';
  kind: 'sync';
  v: 1;
  from: Device;
  /** Gói làm cho máy nào (null = gói đầy đủ, dùng cho máy mới / mọi máy). */
  to: string | null;
  createdAt: string;
  /** Chứa các thay đổi có số thứ tự (since, upto] của máy gửi. */
  since: number;
  upto: number;
  /** Máy gửi đã nhận thay đổi của từng máy khác tới số nào. */
  acks: Record<string, number>;
  settings?: Partial<Settings> & { syncUpdatedAt?: string };
  tables: Partial<Record<SyncTable, Row[]>>;
}
export interface EncryptedPackage { app: 'hihand-finto'; kind: 'sync'; v: 1; encrypted: true; fromName: string; salt: string; iv: string; data: string }

export interface ImportReport {
  from: Device;
  added: number;
  updated: number;
  /** Bản ghi bị xóa (mềm) theo máy kia, kể cả bản trùng mà máy kia đã gộp. */
  removed: number;
  skipped: number;
  perTable: Partial<Record<SyncTable, { added: number; updated: number }>>;
  settingsUpdated: boolean;
  /** Những gì đã tự sửa sau khi gộp (gộp trùng tên, gỡ khoản trừ làm tiền giữ âm…). */
  fixes: string[];
  /** Cần bạn xem lại. */
  warnings: string[];
}

/* ---------- Máy này và các máy đã đồng bộ ---------- */

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

/** Quên một máy: lần sau gửi cho máy đó sẽ là gói đầy đủ. */
export async function forgetPeer(db: FintoDB, peerId: string) {
  const peers = await getPeers(db);
  delete peers[peerId];
  await savePeers(db, peers);
}

/** Số bản ghi đã đổi trên máy này mà máy kia chưa có (chưa xác nhận, không tính phần lấy từ chính máy đó). */
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

/* ---------- Xuất gói ---------- */

const strip = (r: Record<string, unknown>) => {
  const { _seq: _s, ...rest } = r;
  return rest as Row;
};

/** Tạo gói đồng bộ: cho một máy đã biết (chỉ phần thay đổi chưa được xác nhận) hoặc gói đầy đủ (to = null). */
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

/** Số bản ghi trong gói. */
export const packageSize = (p: SyncPackage) => Object.values(p.tables).reduce((a, rows) => a + (rows?.length ?? 0), 0);

/* ---------- Mã hóa (tùy chọn): PBKDF2 + AES-GCM ---------- */

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

/** Chuyển gói thành nội dung file; có mật khẩu thì mã hóa. */
export async function packageToText(pkg: SyncPackage, password?: string): Promise<string> {
  const json = JSON.stringify(pkg);
  if (!password) return json;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await deriveKey(password, salt), te.encode(json));
  const out: EncryptedPackage = { app: 'hihand-finto', kind: 'sync', v: 1, encrypted: true, fromName: pkg.from.name, salt: toB64(salt), iv: toB64(iv), data: toB64(data) };
  return JSON.stringify(out);
}

/** Đọc file gói: trả về gói, hoặc cho biết cần mật khẩu. */
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

/* ---------- Nhập + gộp ---------- */

/** So nội dung ổn định (khóa theo thứ tự) để hai máy luôn chọn cùng một bản khi updatedAt bằng nhau. */
const stable = (r: Row) => JSON.stringify(Object.keys(r).sort().map((k) => [k, r[k]]));
/** > 0: bản `a` thắng. */
const newer = (a: Row, b: Row) => a.updatedAt.localeCompare(b.updatedAt) || stable(a).localeCompare(stable(b));

/** Gộp một gói vào sổ này. Chạy trong một giao dịch: lỗi giữa chừng thì không thay đổi gì. */
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

    // Các bản ghi vừa lấy từ máy gửi: lần sau gửi cho họ thì bỏ qua (họ đã có).
    const echo: [number, number] = [seq0, db.seq];

    // Cài đặt dùng chung: bản đổi sau thắng.
    const inc = pkg.settings;
    const cur = await db.settings.get('settings');
    if (inc?.syncUpdatedAt && cur && (!cur.syncUpdatedAt || inc.syncUpdatedAt > cur.syncUpdatedAt)) {
      const patch = Object.fromEntries([...SYNCED_SETTINGS, 'syncUpdatedAt'].filter((k) => k in inc).map((k) => [k, inc[k as keyof Settings]]));
      await db.settings.update('settings', patch);
      report.settingsUpdated = true;
    }

    if (report.added || report.updated || report.removed) {
      report.fixes.push(...(await dedupe(db)));
      // Quy tắc tiền sau khi gộp (ví dụ hai máy cùng trừ vào một khoản tiền giữ).
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

    // Ghi nhớ đã đồng bộ tới đâu với máy gửi.
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

/* ---------- Gộp trùng sau khi đồng bộ ---------- */

type Live = { id: string; deletedAt?: string | null };
const alive = <T extends Live>(rows: T[]) => rows.filter((r) => !r.deletedAt);

/** Nhóm theo khóa; trong mỗi nhóm giữ mã nhỏ nhất (mọi máy chọn giống nhau). Trả về map mã trùng → mã giữ lại. */
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

/** Xóa dòng liên kết trùng (cùng cặp khóa), giữ mã nhỏ nhất. */
async function dedupeLinks(db: FintoDB, table: SyncTable, key: (r: Record<string, unknown>) => string) {
  const rows = alive((await db.table(table).toArray()) as (Live & Record<string, unknown>)[]);
  const dups = dupMap(rows, key);
  await softDelete(db, table, dups.keys());
  return dups.size;
}

const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();

/**
 * Mỗi trình duyệt tự tạo danh mục / tag mặc định (và có thể tự thêm cùng một người) với mã khác nhau.
 * Sau khi gộp: giữ một bản theo tên, chuyển mọi tham chiếu sang bản giữ lại, xóa mềm bản trùng.
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

/** Tên file gợi ý cho gói. */
export function packageFileName(pkg: SyncPackage, toName?: string) {
  const slug = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
  return `finto-sync-${slug(pkg.from.name)}-${pkg.to ? 'cho-' + slug(toName ?? 'may-khac') : 'day-du'}-${pkg.createdAt.slice(0, 10)}.json`;
}
