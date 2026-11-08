import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { beforeEach, describe, expect, it } from 'vitest';
import { FintoDB, base } from '../db/schema';
import { seedIfEmpty } from '../db/seed';
import { addCategory } from './catalog';
import { exportSheets } from './export';
import { deleteIncome, restoreIncome, saveIncome, setOpeningBalance, updateIncome } from './income';
import { receivePayment, saveExpense } from './ledger';
import { periodRange } from './period';
import { splitEqual } from './split';
import { balanceAt, giftsFromPeople, makeIndex, periodStats, yearStats, type Snapshot } from './stats';

let db: FintoDB;
const P = { me: '', an: '' };
const snap = async (): Promise<Snapshot> => ({
  people: await db.people.toArray(), categories: await db.categories.toArray(), tags: await db.tags.toArray(),
  categoryTags: await db.categoryTags.toArray(), transactions: await db.transactions.toArray(), transactionTags: await db.transactionTags.toArray(),
  shares: await db.shares.toArray(), settlements: await db.settlements.toArray(), allocations: await db.allocations.toArray(),
  incomes: await db.incomes.toArray(), settings: await db.settings.get('settings'),
});
const cat = async (n: string, kind: 'expense' | 'income' = 'expense') =>
  (await db.categories.filter((c) => c.name === n && (c.kind ?? 'expense') === kind).first())!.id;

beforeEach(async () => {
  db = new FintoDB('inc-' + crypto.randomUUID());
  await seedIfEmpty(db);
  for (const [k, n] of [['me', 'Mẹ'], ['an', 'An']] as const) {
    const p = { ...base(), name: n, color: '#fff', defaultType: 'owe' as const };
    await db.people.add(p);
    P[k] = p.id;
  }
});

/** Tháng 11: lương 15tr, mẹ cho 2tr; lẩu 360k chia 3 (An nợ 120k, bao Mẹ 120k); An trả 120k. */
async function november() {
  await saveIncome(db, { date: '2026-11-10', categoryId: await cat('Lương', 'income'), amount: 15_000_000, title: 'Lương T11', personId: null });
  await saveIncome(db, { date: '2026-11-12', categoryId: await cat('Gia đình', 'income'), amount: 2_000_000, title: 'Mẹ cho', personId: P.me });
  await saveExpense(db, {
    date: '2026-11-06', kind: 'expense', categoryId: await cat('Lẩu/nướng/nhà hàng'), title: 'Lẩu', totalAmount: 360_000, splitMode: 'equal', tagIds: [],
    shares: splitEqual(360_000, [{ personId: null, type: 'mine' }, { personId: P.an, type: 'owe' }, { personId: P.me, type: 'give' }]),
  });
  await receivePayment(db, { personId: P.an, date: '2026-11-15', amount: 120_000, picks: [] });
}

describe('thu nhập', () => {
  it('danh mục thu tách khỏi danh mục chi', async () => {
    const ix = makeIndex(await snap());
    expect(ix.incomeRoots.map((c) => c.name)).toEqual(['Lương', 'Thưởng', 'Được cho/tặng', 'Thu nhập phụ', 'Lãi/đầu tư', 'Khác']);
    expect(ix.roots.some((c) => c.name === 'Lương')).toBe(false);
    expect(ix.roots.filter((c) => c.name === 'Khác')).toHaveLength(1);
    // "Khác" có ở cả chi lẫn thu; thêm danh mục con vào danh mục thu thì là danh mục thu
    const sub = await addCategory(db, 'Lì xì', await cat('Được cho/tặng', 'income'));
    expect((await db.categories.get(sub))!.kind).toBe('income');
    await expect(addCategory(db, 'Lương', null, 'wallet', 'income')).rejects.toThrow();
    await addCategory(db, 'Lương', null); // trùng tên nhưng là danh mục chi → được
  });

  it('chặn số tiền ≤ 0 và danh mục chi', async () => {
    await expect(saveIncome(db, { date: '2026-11-10', categoryId: await cat('Lương', 'income'), amount: 0, title: '', personId: null })).rejects.toThrow();
    await expect(saveIncome(db, { date: '2026-11-10', categoryId: await cat('Ăn uống'), amount: 1000, title: '', personId: null })).rejects.toThrow();
  });

  it('RULE-14: còn lại = thu nhập + được trả lại − tổng tiền ra', async () => {
    await november();
    const st = periodStats(makeIndex(await snap()), periodRange('2026-11'));
    expect(st).toMatchObject({ income: 17_000_000, received: 120_000, total: 360_000, net: 16_760_000, mine: 120_000 });
    expect(st.incomeByCategory.map((g) => [g.name, g.amount])).toEqual([['Lương', 15_000_000], ['Được cho/tặng', 2_000_000]]);
    expect(st.incomeByCategory[1].subs[0].name).toBe('Gia đình');
  });

  it('RULE-15: số dư = số dư ban đầu + dòng tiền từ ngày bắt đầu', async () => {
    expect(balanceAt(makeIndex(await snap()))).toBeNull();
    await saveExpense(db, {
      date: '2026-10-20', kind: 'expense', categoryId: await cat('Bữa chính'), title: 'Trước ngày bắt đầu', totalAmount: 50_000, splitMode: 'equal', tagIds: [],
      shares: [{ personId: null, type: 'mine', amount: 50_000 }],
    });
    await setOpeningBalance(db, 5_000_000, '2026-11-01');
    await november();
    const ix = makeIndex(await snap());
    expect(balanceAt(ix)).toBe(5_000_000 + 16_760_000);
    expect(balanceAt(ix, '2026-11-11')).toBe(5_000_000 + 15_000_000 - 360_000);
  });

  it('BR-17: năm có thu nhập và dòng tiền từng tháng', async () => {
    await november();
    const y = yearStats(makeIndex(await snap()), 2026, '2026-11');
    expect(y.months[10]).toMatchObject({ income: 17_000_000, net: 16_760_000 });
    expect(y.stats.income).toBe(17_000_000);
  });

  it('sửa, xóa, hoàn tác; người đã cho bạn', async () => {
    await november();
    let ix = makeIndex(await snap());
    expect(giftsFromPeople(ix)).toEqual([expect.objectContaining({ personId: P.me, total: 2_000_000 })]);
    const r = ix.incomes.find((x) => x.title === 'Mẹ cho')!;
    await updateIncome(db, r.id, { date: r.date, categoryId: r.categoryId, amount: 2_500_000, title: 'Mẹ cho tiền Tết', personId: P.me });
    const stamp = await deleteIncome(db, r.id);
    ix = makeIndex(await snap());
    expect(periodStats(ix, periodRange('2026-11')).income).toBe(15_000_000);
    await restoreIncome(db, r.id, stamp);
    ix = makeIndex(await snap());
    expect(periodStats(ix, periodRange('2026-11')).income).toBe(17_500_000);
    expect(exportSheets(ix, null)[2].rows).toHaveLength(2);
  });
});

describe('nâng cấp dữ liệu', () => {
  it('sổ cũ (v1) mở bằng bản mới: giữ dữ liệu, thêm bảng thu nhập và danh mục thu', async () => {
    const name = 'old-' + crypto.randomUUID();
    const old = new Dexie(name);
    old.version(1).stores({
      people: 'id, name, updatedAt', groups: 'id, updatedAt', groupMembers: 'id, groupId, personId, updatedAt',
      categories: 'id, parentId, sortOrder, updatedAt', tags: 'id, name, updatedAt', categoryTags: 'id, categoryId, tagId, updatedAt',
      transactions: 'id, date, categoryId, kind, updatedAt', transactionTags: 'id, transactionId, tagId, updatedAt',
      shares: 'id, transactionId, personId, type, updatedAt', settlements: 'id, personId, date, updatedAt',
      allocations: 'id, settlementId, shareId, personId, updatedAt', monthNotes: 'id, [personId+month], updatedAt', settings: 'id',
    });
    await old.table('settings').put({ id: 'settings', theme: 'dark', monthStartDay: 1, monthEndNote: true, autoApplyCredit: true, seeded: true });
    await old.table('categories').add({ ...base(), name: 'Ăn uống', icon: 'utensils', parentId: null, countsAsMine: true, sortOrder: 0 });
    old.close();

    const upgraded = new FintoDB(name);
    await seedIfEmpty(upgraded);
    const cats = await upgraded.categories.toArray();
    expect(cats.filter((c) => c.kind !== 'income' && !c.parentId).map((c) => c.name).sort()).toEqual(['Hóa đơn', 'Ăn uống'].sort());
    expect(cats.filter((c) => c.kind === 'income' && !c.parentId)).toHaveLength(6);
    expect(await upgraded.incomes.count()).toBe(0);
    await seedIfEmpty(upgraded); // chạy lại không tạo trùng
    expect((await upgraded.categories.toArray()).filter((c) => c.kind === 'income' && !c.parentId)).toHaveLength(6);
  });
});
