import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { FintoDB, base } from '../db/schema';
import { seedIfEmpty } from '../db/seed';
import { deleteIncome, restoreIncome, setOpeningBalance, updateIncome } from './income';
import { creditOf, deleteSettlement, deleteTransaction, forgiveShare, restoreTransaction, returnCredit, saveExpense, settle } from './ledger';
import { balanceAt, makeIndex, openDebts, type Snapshot } from './stats';

let db: FintoDB;
let A = '';
const snap = async (): Promise<Snapshot> => ({
  people: await db.people.toArray(), categories: await db.categories.toArray(), tags: await db.tags.toArray(),
  categoryTags: await db.categoryTags.toArray(), transactions: await db.transactions.toArray(), transactionTags: await db.transactionTags.toArray(),
  shares: await db.shares.toArray(), settlements: await db.settlements.toArray(), allocations: await db.allocations.toArray(),
  incomes: await db.incomes.toArray(), settings: await db.settings.get('settings'),
});
const cat = async (n: string, kind = 'expense') => (await db.categories.filter((c) => c.name === n && (c.kind ?? 'expense') === kind).first())!.id;
const meal = async (date = '2026-11-05') => saveExpense(db, {
  date, kind: 'expense', categoryId: await cat('Bữa chính'), title: 'Ăn', totalAmount: 190_000, splitMode: 'equal', tagIds: [],
  shares: [{ personId: null, type: 'mine', amount: 95_000 }, { personId: A, type: 'owe', amount: 95_000 }],
});

beforeEach(async () => {
  db = new FintoDB('rv-' + crypto.randomUUID());
  await seedIfEmpty(db);
  await setOpeningBalance(db, 1_000_000, '2026-11-01');
  const p = { ...base(), name: 'A', color: '#fff', defaultType: 'owe' as const };
  await db.people.add(p);
  A = p.id;
});

describe('review: input validation', () => {
  it('blocks empty / invalid dates in every write', async () => {
    await expect(meal('')).rejects.toThrow();
    await expect(settle(db, { personId: A, date: '', amount: 1000, picks: [] })).rejects.toThrow();
    await settle(db, { personId: A, date: '2026-11-02', amount: 1000, picks: [] });
    await expect(returnCredit(db, A, 500, '2026-13-40')).rejects.toThrow();
    await meal();
    const [d] = openDebts(makeIndex(await snap()), A);
    await expect(forgiveShare(db, d.share.id, 1000, '')).rejects.toThrow();
  });

  it('blocks unknown categories or income categories when saving an expense', async () => {
    const base0 = { date: '2026-11-05', kind: 'expense' as const, title: 'x', totalAmount: 1000, splitMode: 'equal' as const, tagIds: [], shares: [{ personId: null, type: 'mine' as const, amount: 1000 }] };
    await expect(saveExpense(db, { ...base0, categoryId: 'khong-co' })).rejects.toThrow();
    await expect(saveExpense(db, { ...base0, categoryId: await cat('Lương', 'income') })).rejects.toThrow();
  });
});

describe('review: gifted surplus tied to a payment', () => {
  it('deleting only the gifted surplus keeps the account balance (the money did come in); it becomes held money', async () => {
    await meal();
    const [d] = openDebts(makeIndex(await snap()), A);
    await settle(db, { personId: A, date: '2026-11-06', amount: 100_000, picks: [{ shareId: d.share.id, amount: 95_000 }], surplus: 'gift' });
    const before = balanceAt(makeIndex(await snap()));
    const gift = (await db.incomes.toArray()).find((r) => r.settlementId)!;
    const stamp = await deleteIncome(db, gift.id);
    expect(balanceAt(makeIndex(await snap()))).toBe(before);
    expect(await creditOf(db, A)).toBe(5_000);
    await restoreIncome(db, gift.id, stamp);
    expect(balanceAt(makeIndex(await snap()))).toBe(before);
    expect(await creditOf(db, A)).toBe(0);
  });

  it('the gifted surplus amount cannot be edited (edit the payment instead)', async () => {
    await meal();
    const [d] = openDebts(makeIndex(await snap()), A);
    await settle(db, { personId: A, date: '2026-11-06', amount: 100_000, picks: [{ shareId: d.share.id, amount: 95_000 }], surplus: 'gift' });
    const r = (await db.incomes.toArray())[0];
    expect(r.settlementId).toBeTruthy();
    await expect(updateIncome(db, r.id, { date: r.date, categoryId: r.categoryId, amount: 200_000, title: 'x', personId: A })).rejects.toThrow();
    await updateIncome(db, r.id, { date: r.date, categoryId: r.categoryId, amount: r.amount, title: 'Quà sinh nhật', personId: A });
  });
});

describe('review: undo', () => {
  it('undoing a transaction delete after its payment was deleted: held money stays non-negative', async () => {
    await meal();
    const [d] = openDebts(makeIndex(await snap()), A);
    const st = await settle(db, { personId: A, date: '2026-11-06', amount: 95_000, picks: [{ shareId: d.share.id, amount: 95_000 }] });
    const tx = d.share.transactionId;
    const stamp = await deleteTransaction(db, tx);
    await deleteSettlement(db, st!);
    await restoreTransaction(db, tx, stamp);
    expect(await creditOf(db, A)).toBeGreaterThanOrEqual(0);
    expect(openDebts(makeIndex(await snap()), A)[0].remaining).toBe(95_000);
  });
});
