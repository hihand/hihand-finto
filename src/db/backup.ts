import { db } from './schema';
import { seedBills, seedIncomeCategories, seedPayFor } from './seed';

const TABLES = ['people', 'groups', 'groupMembers', 'categories', 'tags', 'categoryTags', 'transactions',
  'transactionTags', 'shares', 'settlements', 'allocations', 'monthNotes', 'incomes', 'payables', 'repayments', 'settings'] as const;

export interface BackupFile {
  app: 'hihand-finto';
  version: 1;
  exportedAt: string;
  tables: Record<string, unknown[]>;
}

/** BR-15: xuất toàn bộ dữ liệu ra file JSON. */
export async function exportBackup(): Promise<Blob> {
  const tables: Record<string, unknown[]> = {};
  for (const t of TABLES) tables[t] = await db.table(t).toArray();
  const file: BackupFile = { app: 'hihand-finto', version: 1, exportedAt: new Date().toISOString(), tables };
  return new Blob([JSON.stringify(file)], { type: 'application/json' });
}

/** Khôi phục: thay toàn bộ dữ liệu hiện có bằng nội dung file. */
/** Bảng có thể thiếu trong file sao lưu cũ (thêm ở bản sau). */
const OPTIONAL = new Set<string>(['incomes', 'payables', 'repayments']);

/** Kiểm tra file trước khi xóa gì: sai thì báo lỗi và dữ liệu hiện có giữ nguyên. */
function validate(text: string): BackupFile {
  let file: BackupFile;
  try {
    file = JSON.parse(text) as BackupFile;
  } catch {
    throw new Error('File sao lưu không đọc được (không phải JSON)');
  }
  if (!file || file.app !== 'hihand-finto' || file.version !== 1 || typeof file.tables !== 'object' || !file.tables) {
    throw new Error('File sao lưu không hợp lệ');
  }
  for (const t of TABLES) {
    const rows = file.tables[t];
    if (rows === undefined && OPTIONAL.has(t)) continue;
    if (!Array.isArray(rows)) throw new Error(`File sao lưu thiếu hoặc hỏng bảng “${t}”`);
    if (rows.some((r) => !r || typeof r !== 'object' || typeof (r as { id?: unknown }).id !== 'string')) {
      throw new Error(`Bảng “${t}” trong file sao lưu có dòng không hợp lệ`);
    }
  }
  if (!(file.tables.settings as { id: string }[]).some((r) => r.id === 'settings')) throw new Error('File sao lưu thiếu phần cài đặt');
  return file;
}

/** Khôi phục: thay toàn bộ dữ liệu hiện có bằng nội dung file (một giao dịch: lỗi giữa chừng không mất gì). */
export async function importBackup(text: string) {
  const file = validate(text);
  await db.transaction('rw', TABLES.map((t) => db.table(t)), async () => {
    for (const t of TABLES) {
      await db.table(t).clear();
      await db.table(t).bulkAdd(file.tables[t] ?? []);
    }
  });
  // File sao lưu từ bản chưa có thu nhập: tạo danh mục thu mặc định.
  await seedIncomeCategories(db);
  // Dữ liệu đã thay hết: đổi mã máy và quên các máy đã đồng bộ, để lần đồng bộ sau là gói đầy đủ ở cả hai phía.
  await db.meta.delete('peers');
  const dev = (await db.meta.get('device'))?.value as { name?: string } | undefined;
  if (dev) await db.meta.put({ key: 'device', value: { id: crypto.randomUUID(), name: dev.name ?? 'Trình duyệt' } });
  await seedBills(db);
  await seedPayFor(db);
}
