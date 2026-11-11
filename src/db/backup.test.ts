import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { exportBackup, importBackup } from './backup';
import { base, db } from './schema';
import { seedIfEmpty } from './seed';

describe('backup / restore (BR-15)', () => {
  it('a file with a missing table or wrong types is rejected and existing data is kept', async () => {
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
    // a valid file (including old ones without the incomes / debt tables) still restores
    const old = { ...good, tables: { ...good.tables } };
    delete old.tables.incomes;
    delete old.tables.payables;
    delete old.tables.repayments;
    await importBackup(JSON.stringify(old));
    expect(await db.people.count()).toBe(1);
  });
});
