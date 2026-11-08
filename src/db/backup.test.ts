import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { exportBackup, importBackup } from './backup';
import { base, db } from './schema';
import { seedIfEmpty } from './seed';

describe('sao lưu / khôi phục (BR-15)', () => {
  it('file thiếu bảng hoặc sai kiểu bị từ chối và dữ liệu hiện có giữ nguyên', async () => {
    await seedIfEmpty(db);
    await db.people.add({ ...base(), name: 'An', color: '#fff', defaultType: 'owe' });
    const good = JSON.parse(await (await exportBackup()).text());
    const broken = { ...good, tables: { ...good.tables } };
    delete broken.tables.people;
    await expect(importBackup(JSON.stringify(broken))).rejects.toThrow();
    await expect(importBackup(JSON.stringify({ ...good, tables: { ...good.tables, shares: 'x' } }))).rejects.toThrow();
    await expect(importBackup(JSON.stringify({ ...good, tables: { ...good.tables, people: [{ name: 'không id' }] } }))).rejects.toThrow();
    await expect(importBackup('không phải json')).rejects.toThrow();
    expect(await db.people.count()).toBe(1);
    // file hợp lệ (kể cả bản cũ chưa có bảng incomes) vẫn khôi phục được
    const old = { ...good, tables: { ...good.tables } };
    delete old.tables.incomes;
    await importBackup(JSON.stringify(old));
    expect(await db.people.count()).toBe(1);
  });
});
