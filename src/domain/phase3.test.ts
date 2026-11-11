import 'fake-indexeddb/auto';
import { strFromU8, unzipSync } from 'fflate';
import { beforeEach, describe, expect, it } from 'vitest';
import { FintoDB, base } from '../db/schema';
import { seedIfEmpty } from '../db/seed';
import { buildXlsx } from '../lib/xlsx';
import { deleteGroup, saveGroup } from './catalog';
import { exportSheets } from './export';
import { receivePayment, saveExpense } from './ledger';
import { backupOverdueDays, runMonthEnd } from './monthEnd';
import { periodRange } from './period';
import { splitEqual } from './split';
import { makeIndex, yearStats, type Snapshot } from './stats';

let db: FintoDB;
const P = { an: '', binh: '' };
const snap = async (): Promise<Snapshot> => ({
  people: await db.people.toArray(), categories: await db.categories.toArray(), tags: await db.tags.toArray(),
  categoryTags: await db.categoryTags.toArray(), transactions: await db.transactions.toArray(), transactionTags: await db.transactionTags.toArray(),
  shares: await db.shares.toArray(), settlements: await db.settlements.toArray(), allocations: await db.allocations.toArray(),
  groups: await db.groups.toArray(), groupMembers: await db.groupMembers.toArray(), monthNotes: await db.monthNotes.toArray(),
  settings: await db.settings.get('settings'),
});
const cat = async (n: string) => (await db.categories.filter((c) => c.name === n).first())!.id;
const lau = async (date: string, total = 360000) => saveExpense(db, {
  date, kind: 'expense', categoryId: await cat('Lẩu/nướng/nhà hàng'), title: 'Lẩu & "nướng" <tối>', totalAmount: total, splitMode: 'equal', tagIds: [],
  shares: splitEqual(total, [{ personId: null, type: 'mine' }, { personId: P.an, type: 'owe' }, { personId: P.binh, type: 'give' }]),
});

beforeEach(async () => {
  db = new FintoDB('p3-' + crypto.randomUUID());
  await seedIfEmpty(db);
  for (const k of Object.keys(P) as (keyof typeof P)[]) {
    const p = { ...base(), name: k, color: '#fff', defaultType: 'owe' as const };
    await db.people.add(p);
    P[k] = p.id;
  }
});

describe('BR-17 yearly stats', () => {
  it('12 months, average over the months elapsed', async () => {
    await lau('2026-01-10', 300000);
    await lau('2026-03-05', 600000);
    const y = yearStats(makeIndex(await snap()), 2026, '2026-04');
    expect(y.months).toHaveLength(12);
    expect(y.months.map((m) => m.mine).slice(0, 4)).toEqual([100000, 0, 200000, 0]);
    expect(y.stats.mine).toBe(300000);
    expect(y.elapsed).toBe(4);
    expect(y.average).toBe(75000);
    expect(yearStats(makeIndex(await snap()), 2025, '2026-04').elapsed).toBe(12);
  });
});

describe('BR-18 groups & month-end notes', () => {
  it('create, edit members, delete a group', async () => {
    const id = await saveGroup(db, { name: 'Hội bạn thân', memberIds: [P.an, P.binh] });
    await saveGroup(db, { id, name: 'Hội bạn', memberIds: [P.an] });
    let ix = makeIndex(await snap());
    expect(ix.groups).toHaveLength(1);
    expect(ix.groups[0]).toMatchObject({ memberIds: [P.an] });
    expect(ix.groups[0].group.name).toBe('Hội bạn');
    await expect(saveGroup(db, { name: 'Trống', memberIds: [] })).rejects.toThrow();
    await deleteGroup(db, id);
    ix = makeIndex(await snap());
    expect(ix.groups).toHaveLength(0);
  });

  it('first run only marks the period; a new period writes "An chuyển dư 60k"', async () => {
    expect(await runMonthEnd(db, '2026-11-08')).toBe(0);
    await lau('2026-11-06');
    await receivePayment(db, { personId: P.an, date: '2026-11-07', amount: 180000, picks: [] });
    // hotpot created before An deposited → An owes 120k, holding 180k; apply 120k → 60k held
    const sh = (await db.shares.where('personId').equals(P.an).first())!;
    await receivePayment(db, { personId: P.an, date: '2026-11-08', amount: 1, picks: [{ shareId: sh.id, amount: 120000 }] });
    expect(await runMonthEnd(db, '2026-11-20')).toBe(0); // same period
    expect(await runMonthEnd(db, '2026-12-01')).toBe(1);
    expect(await runMonthEnd(db, '2026-12-02')).toBe(0); // no duplicate
    const ix = makeIndex(await snap());
    expect(ix.lastNote.get(P.an)).toMatchObject({ month: '2026-11', creditAmount: 60001 });
  });

  it('month-end notes off → nothing written', async () => {
    await runMonthEnd(db, '2026-11-08');
    await db.settings.update('settings', { monthEndNote: false });
    await receivePayment(db, { personId: P.an, date: '2026-11-07', amount: 50000, picks: [] });
    expect(await runMonthEnd(db, '2026-12-01')).toBe(0);
  });
});

describe('NFR-04 backup reminder', () => {
  it('reminds only after 7 days', () => {
    const now = new Date('2026-11-20T00:00:00Z');
    expect(backupOverdueDays(undefined, undefined, now)).toBe(0);
    expect(backupOverdueDays('2026-11-15T00:00:00Z', '2026-01-01T00:00:00Z', now)).toBe(0);
    expect(backupOverdueDays(undefined, '2026-11-01T00:00:00Z', now)).toBe(19);
    expect(backupOverdueDays('2026-11-10T00:00:00Z', undefined, now)).toBe(10);
  });
});

describe('BR-19 Excel export', () => {
  it('one row per share, filtered by period, valid xlsx file', async () => {
    await lau('2026-10-30');
    await lau('2026-11-06');
    await receivePayment(db, { personId: P.an, date: '2026-11-07', amount: 200000, picks: [] });
    const ix = makeIndex(await snap());
    const [shares, settle] = exportSheets(ix, periodRange('2026-11'));
    expect(shares.rows).toHaveLength(3);
    expect(shares.rows.map((r) => r[9])).toEqual(['Của tôi', 'Đòi lại', 'Cho đi']);
    expect(settle.rows).toHaveLength(1);
    expect(exportSheets(ix, null)[0].rows).toHaveLength(6);
    const bytes = buildXlsx(exportSheets(ix, null));
    expect(bytes[0]).toBe(0x50); // "PK"
    const files = unzipSync(bytes);
    expect(Object.keys(files)).toContain('xl/worksheets/sheet2.xml');
    expect(strFromU8(files['xl/worksheets/sheet1.xml'])).toContain('Lẩu &amp; &quot;nướng&quot; &lt;tối&gt;');
  });
});
