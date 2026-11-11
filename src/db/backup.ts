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

/** BR-15: export all data to a JSON file. */
export async function exportBackup(): Promise<Blob> {
  const tables: Record<string, unknown[]> = {};
  for (const t of TABLES) tables[t] = await db.table(t).toArray();
  const file: BackupFile = { app: 'hihand-finto', version: 1, exportedAt: new Date().toISOString(), tables };
  return new Blob([JSON.stringify(file)], { type: 'application/json' });
}

/** Restore: replace all existing data with the file contents. */
/** Tables that may be missing from old backup files (added in later versions). */
const OPTIONAL = new Set<string>(['incomes', 'payables', 'repayments']);

/** Validate the file before deleting anything: on error, existing data is kept. */
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

/** Restore: replace all existing data with the file contents (one transaction: a failure halfway loses nothing). */
export async function importBackup(text: string) {
  const file = validate(text);
  await db.transaction('rw', TABLES.map((t) => db.table(t)), async () => {
    for (const t of TABLES) {
      await db.table(t).clear();
      await db.table(t).bulkAdd(file.tables[t] ?? []);
    }
  });
  // Backup from a version without incomes: create the default income categories.
  await seedIncomeCategories(db);
  // All data was replaced: change the device id and forget synced browsers, so the next sync is a full one on both sides.
  await db.meta.delete('peers');
  const dev = (await db.meta.get('device'))?.value as { name?: string } | undefined;
  if (dev) await db.meta.put({ key: 'device', value: { id: crypto.randomUUID(), name: dev.name ?? 'Trình duyệt' } });
  await seedBills(db);
  await seedPayFor(db);
}
