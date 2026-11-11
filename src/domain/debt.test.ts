import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { FintoDB, base } from '../db/schema';
import { PAY_FOR, seedIfEmpty, seedPayFor } from '../db/seed';
import { borrow, deleteAllocations, deleteRepayments, forgiveAll, heldToDebt, offsetDebts, repay, restoreRepayments, setOpening, waiveDebt } from './debt';
import { deleteIncome, restoreIncome, saveIncome, setOpeningBalance, updateIncome } from './income';
import { creditOf, deleteTransaction, forgiveShare, owedOf, restoreTransaction, returnCredit, saveExpense, type PersonSettle } from './ledger';
import { periodRange } from './period';
import {
  balanceAt, debtLedger, debtSummary, heldAt, makeIndex, openDebts, outstanding, owedAt, owedTo, peopleSummary, periodStats, personalBalanceAt, repayTxs, type Snapshot,
} from './stats';

let db: FintoDB;
let MOM = '';
const snap = async (): Promise<Snapshot> => ({
  people: await db.people.toArray(), categories: await db.categories.toArray(), tags: await db.tags.toArray(),
  categoryTags: await db.categoryTags.toArray(), transactions: await db.transactions.toArray(), transactionTags: await db.transactionTags.toArray(),
  shares: await db.shares.toArray(), settlements: await db.settlements.toArray(), allocations: await db.allocations.toArray(),
  incomes: await db.incomes.toArray(), payables: await db.payables.toArray(), repayments: await db.repayments.toArray(), settings: await db.settings.get('settings'),
});
const ix = async () => makeIndex(await snap());
const cat = async (n: string) => (await db.categories.filter((c) => c.name === n && c.kind !== 'income').first())!.id;
const salary = async () => (await db.categories.filter((c) => c.name === 'Lương').first())!.id;
const NOV = periodRange('2026-11');
const ixParent = (x: Awaited<ReturnType<typeof ix>>, id: string) => x.category.get(id)?.name;
const START = 1_000_000;

/** Pay on behalf of Mom (a bill / a transfer to Mom's partner). */
const onBehalf = async (amount: number, opt?: PersonSettle, date = '2026-11-10') => saveExpense(db, {
  date, kind: 'expense', categoryId: await cat('Điện'), title: 'Chuyển cho đối tác của mẹ', totalAmount: amount, splitMode: 'custom', tagIds: [],
  shares: [{ personId: MOM, type: 'owe', amount }], onBehalf: true, perPerson: opt ? { [MOM]: opt } : undefined,
});

beforeEach(async () => {
  db = new FintoDB('debt-' + crypto.randomUUID());
  await seedIfEmpty(db);
  await setOpeningBalance(db, START, '2026-11-01');
  const p = { ...base(), name: 'Mẹ', color: '#fff', defaultType: 'owe' as const };
  await db.people.add(p);
  MOM = p.id;
});

describe('UC-14: opening balances', () => {
  it('owing Mom 12M from before: not income, account balance unchanged, not deducted from My balance', async () => {
    await setOpening(db, { personId: MOM, date: '2026-11-01', held: 0, owedByMe: 12_000_000, owedToMe: 0 });
    const x = await ix();
    expect(balanceAt(x)).toBe(START);
    expect(personalBalanceAt(x)).toBe(START);
    expect(owedAt(x)).toEqual({ total: 12_000_000, opening: 12_000_000, inApp: 0 });
    expect(periodStats(x, NOV)).toMatchObject({ income: 0, received: 0, net: 0, repaid: 0 });
    expect(debtSummary(x)).toEqual([{ personId: MOM, iOwe: 12_000_000, theyOwe: 0 }]);
  });

  it('opening held money is part of the opening balance; opening "they owe me" is not money out', async () => {
    await setOpening(db, { personId: MOM, date: '2026-11-01', held: 2_000_000, owedByMe: 0, owedToMe: 1_000_000 });
    const x = await ix();
    expect(balanceAt(x)).toBe(START);
    expect(heldAt(x)).toBe(2_000_000);
    expect(personalBalanceAt(x)).toBe(START - 2_000_000);
    expect(outstanding(x)).toMatchObject([{ personId: MOM, amount: 1_000_000 }]);
    expect(periodStats(x, NOV)).toMatchObject({ total: 0, received: 0, owe: 0, advanced: 0, net: 0 });
    expect(x.txs).toHaveLength(0); // not shown in the transaction list
  });

  it('editing opening balances: cannot go below what was repaid; back to 0 when unused removes it', async () => {
    await setOpening(db, { personId: MOM, date: '2026-11-01', held: 0, owedByMe: 12_000_000, owedToMe: 0 });
    await repay(db, { personId: MOM, date: '2026-11-05', amount: 5_000_000, mode: 'transfer' });
    await expect(setOpening(db, { personId: MOM, date: '2026-11-01', held: 0, owedByMe: 4_000_000, owedToMe: 0 })).rejects.toThrow();
    await setOpening(db, { personId: MOM, date: '2026-11-01', held: 0, owedByMe: 10_000_000, owedToMe: 0 });
    expect(await owedOf(db, MOM)).toBe(5_000_000);
    await setOpening(db, { personId: MOM, date: '2026-11-01', held: 0, owedByMe: 10_000_000, owedToMe: 300_000 });
    await setOpening(db, { personId: MOM, date: '2026-11-01', held: 0, owedByMe: 10_000_000, owedToMe: 0 });
    expect(outstanding(await ix())).toHaveLength(0);
  });
});

describe('UC-17: paying on behalf offsets what I owe', () => {
  beforeEach(() => setOpening(db, { personId: MOM, date: '2026-11-01', held: 0, owedByMe: 12_000_000, owedToMe: 0 }));

  it('owe 12M, pay 18M on behalf → 12M settled, Mom owes back 6M; forgiving 6M becomes Given', async () => {
    const txId = await onBehalf(18_000_000);
    let x = await ix();
    expect(owedTo(x, MOM)).toBe(0);
    expect(openDebts(x, MOM)).toMatchObject([{ remaining: 6_000_000, paid: 12_000_000 }]);
    expect(balanceAt(x)).toBe(START - 18_000_000);
    expect(personalBalanceAt(x)).toBe(START - 18_000_000);
    expect(periodStats(x, NOV)).toMatchObject({ repaid: 12_000_000, repaidOld: 12_000_000, advanced: 6_000_000, owe: 6_000_000, spent: 0, net: -12_000_000 });
    // the 12M offset is a repayment, not part of Owed
    expect(peopleSummary(x, 'owe')).toMatchObject([{ total: 6_000_000, waiting: 6_000_000 }]);
    expect(periodStats(x, NOV).oweByPerson[0].amount).toBe(6_000_000);
    expect(debtLedger(x, MOM).map((e) => e.balance)).toEqual([12_000_000, 0]);

    await forgiveShare(db, openDebts(x, MOM)[0].share.id, 6_000_000, '2026-11-12');
    x = await ix();
    expect(openDebts(x, MOM)).toHaveLength(0);
    expect(periodStats(x, NOV)).toMatchObject({ give: 0, forgiven: 6_000_000, spent: 6_000_000, advanced: 0, net: -18_000_000 });

    // Deleting the on-behalf payment removes the offset, the 12M debt comes back; undo settles it again.
    const stamp = await deleteTransaction(db, txId);
    expect(await owedOf(db, MOM)).toBe(12_000_000);
    await restoreTransaction(db, txId, stamp);
    expect(await owedOf(db, MOM)).toBe(0);
  });

  it('choosing "Give it to Mom" for the rest while paying on behalf', async () => {
    await onBehalf(18_000_000, { rest: 'give' });
    const x = await ix();
    expect(openDebts(x, MOM)).toHaveLength(0);
    expect(periodStats(x, NOV)).toMatchObject({ repaid: 12_000_000, forgiven: 6_000_000, spent: 6_000_000, advanced: 0 });
  });

  it('deduction order: held money → offset → Mom owes the rest', async () => {
    await setOpening(db, { personId: MOM, date: '2026-11-01', held: 3_000_000, owedByMe: 12_000_000, owedToMe: 0 });
    await onBehalf(18_000_000);
    const x = await ix();
    expect(await creditOf(db, MOM)).toBe(0);
    expect(owedTo(x, MOM)).toBe(0);
    expect(openDebts(x, MOM)[0].remaining).toBe(3_000_000);
    expect(periodStats(x, NOV)).toMatchObject({ repaid: 12_000_000, advanced: 3_000_000 });
  });

  it('unticking offset: two separate debts, then a manual offset (undoable)', async () => {
    await onBehalf(2_000_000, { offset: false });
    expect(await owedOf(db, MOM)).toBe(12_000_000);
    expect(openDebts(await ix(), MOM)[0].remaining).toBe(2_000_000);
    const ids = await offsetDebts(db, MOM, '2026-11-15');
    const x = await ix();
    expect(peopleSummary(x, 'owe')).toHaveLength(0); // fully offset → no longer Owed
    expect(owedTo(x, MOM)).toBe(10_000_000);
    expect(openDebts(x, MOM)).toHaveLength(0);
    expect(periodStats(x, NOV).repaid).toBe(2_000_000);
    await deleteAllocations(db, ids);
    expect(await owedOf(db, MOM)).toBe(12_000_000);
  });

  it('split meal: Mom\'s share is offset against what I owe', async () => {
    await saveExpense(db, {
      date: '2026-11-08', kind: 'expense', categoryId: await cat('Bữa chính'), title: 'Ăn tối', totalAmount: 600_000, splitMode: 'equal', tagIds: [],
      shares: [{ personId: null, type: 'mine', amount: 300_000 }, { personId: MOM, type: 'owe', amount: 300_000 }],
    });
    expect(await owedOf(db, MOM)).toBe(11_700_000);
  });
});

describe('UC-16: repaying from income', () => {
  beforeEach(() => setOpening(db, { personId: MOM, date: '2026-11-01', held: 0, owedByMe: 12_000_000, owedToMe: 0 }));
  const income = (repayIt?: { amount: number; mode?: 'hold' | 'transfer' }) => salary().then((c) => saveIncome(db,
    { date: '2026-11-05', categoryId: c, amount: 20_000_000, title: 'Lương', personId: null }, repayIt && { personId: MOM, ...repayIt }));

  it('keep for Mom (hold): money stays in the account as held money; Left over and My balance go down', async () => {
    await income({ amount: 12_000_000 });
    const x = await ix();
    expect(owedTo(x, MOM)).toBe(0);
    expect(await creditOf(db, MOM)).toBe(12_000_000);
    expect(balanceAt(x)).toBe(START + 20_000_000);
    expect(personalBalanceAt(x)).toBe(START + 8_000_000);
    expect(periodStats(x, NOV)).toMatchObject({ income: 20_000_000, repaid: 12_000_000, net: 8_000_000, spent: 0 });

    // Then transfer that 12M to Mom: not counted as money out again.
    await returnCredit(db, MOM, 12_000_000, '2026-11-06');
    const y = await ix();
    expect(balanceAt(y)).toBe(START + 8_000_000);
    expect(personalBalanceAt(y)).toBe(START + 8_000_000);
    expect(periodStats(y, NOV).net).toBe(8_000_000);
  });

  it('bank transfer (transfer): account goes down; My balance ends the same as hold', async () => {
    await income({ amount: 12_000_000, mode: 'transfer' });
    const x = await ix();
    expect(balanceAt(x)).toBe(START + 8_000_000);
    expect(heldAt(x)).toBe(0);
    expect(personalBalanceAt(x)).toBe(START + 8_000_000);
    expect(periodStats(x, NOV).net).toBe(8_000_000);
  });

  it('deleting the income deletes its repayment; undo brings it back; income cannot go below what it repaid', async () => {
    const id = await income({ amount: 12_000_000 });
    await expect(updateIncome(db, id, { date: '2026-11-05', categoryId: await salary(), amount: 10_000_000, title: 'Lương', personId: null })).rejects.toThrow();
    const stamp = await deleteIncome(db, id);
    expect(await owedOf(db, MOM)).toBe(12_000_000);
    expect(await creditOf(db, MOM)).toBe(0);
    await restoreIncome(db, id, stamp);
    expect(await owedOf(db, MOM)).toBe(0);
  });

  it('cannot repay more than owed / more than the income; a hold repayment already spent on behalf cannot be deleted', async () => {
    await expect(income({ amount: 13_000_000 })).rejects.toThrow();
    await expect(salary().then((c) => saveIncome(db, { date: '2026-11-05', categoryId: c, amount: 1_000_000, title: '', personId: null }, { personId: MOM, amount: 2_000_000 }))).rejects.toThrow();
    const ids = await repay(db, { personId: MOM, date: '2026-11-05', amount: 5_000_000 });
    await onBehalf(4_000_000, undefined, '2026-11-06');
    await expect(deleteRepayments(db, ids)).rejects.toThrow();
    expect(await owedOf(db, MOM)).toBe(7_000_000);
  });
});

describe('UC-18 / UC-19: forgiving debts both ways', () => {
  it('Mom forgives the opening debt: not income, My balance unchanged', async () => {
    await setOpening(db, { personId: MOM, date: '2026-11-01', held: 0, owedByMe: 12_000_000, owedToMe: 0 });
    await waiveDebt(db, { personId: MOM, date: '2026-11-20', amount: 12_000_000 });
    const x = await ix();
    expect(owedTo(x, MOM)).toBe(0);
    expect(personalBalanceAt(x)).toBe(START);
    expect(periodStats(x, NOV)).toMatchObject({ waived: 12_000_000, waivedNew: 0, net: 0, income: 0 });
  });

  it('I forgive Mom: in-app debts count as spending; opening ones do not', async () => {
    await setOpening(db, { personId: MOM, date: '2026-11-01', held: 0, owedByMe: 0, owedToMe: 1_000_000 });
    await onBehalf(500_000); // trong app
    await forgiveAll(db, MOM, 1_500_000, '2026-11-20'); // oldest first: 1M opening, then 500k
    const x = await ix();
    expect(openDebts(x, MOM)).toHaveLength(0);
    expect(periodStats(x, NOV)).toMatchObject({ forgiven: 500_000, forgivenOld: 1_000_000, spent: 500_000, net: -500_000 });
    expect(peopleSummary(x, 'give')[0].total).toBe(1_500_000); // both show as Given
    await expect(forgiveAll(db, MOM, 1, '2026-11-20')).rejects.toThrow();
  });
});

describe('UC-15: debts created in the app', () => {
  it('new 5M loan: money in is not income, My balance unchanged; repaying it does not reduce Left over', async () => {
    await borrow(db, { personId: MOM, date: '2026-11-03', amount: 5_000_000 });
    let x = await ix();
    expect(balanceAt(x)).toBe(START + 5_000_000);
    expect(personalBalanceAt(x)).toBe(START);
    expect(owedAt(x)).toMatchObject({ inApp: 5_000_000, opening: 0 });
    expect(periodStats(x, NOV)).toMatchObject({ income: 0, borrowed: 5_000_000, net: 0 });
    await repay(db, { personId: MOM, date: '2026-11-25', amount: 5_000_000, mode: 'transfer' });
    x = await ix();
    expect(balanceAt(x)).toBe(START);
    expect(personalBalanceAt(x)).toBe(START);
    expect(periodStats(x, NOV)).toMatchObject({ repaid: 5_000_000, repaidOld: 0, net: 0 });
  });

  it('spent 3M of held money → turned into a debt; Mom forgiving it counts like a gift', async () => {
    await setOpening(db, { personId: MOM, date: '2026-11-01', held: 5_000_000, owedByMe: 0, owedToMe: 0 });
    await saveExpense(db, {
      date: '2026-11-04', kind: 'expense', categoryId: await cat('Bữa chính'), title: 'Tự tiêu', totalAmount: 3_000_000, splitMode: 'equal', tagIds: [],
      shares: [{ personId: null, type: 'mine', amount: 3_000_000 }],
    });
    const before = personalBalanceAt(await ix());
    await heldToDebt(db, { personId: MOM, date: '2026-11-04', amount: 3_000_000 });
    let x = await ix();
    expect(await creditOf(db, MOM)).toBe(2_000_000);
    expect(owedTo(x, MOM)).toBe(3_000_000);
    expect(personalBalanceAt(x)).toBe(before);
    expect(balanceAt(x)).toBe(START - 3_000_000);
    await expect(heldToDebt(db, { personId: MOM, date: '2026-11-04', amount: 3_000_000 })).rejects.toThrow();

    await waiveDebt(db, { personId: MOM, date: '2026-11-20', amount: 3_000_000 });
    x = await ix();
    expect(personalBalanceAt(x)).toBe(before! + 3_000_000);
    expect(periodStats(x, NOV)).toMatchObject({ waivedNew: 3_000_000, spent: 3_000_000, net: 0 });
  });

  it('end-of-period balance: debt remaining at a date', async () => {
    await setOpening(db, { personId: MOM, date: '2026-11-01', held: 0, owedByMe: 12_000_000, owedToMe: 0 });
    await repay(db, { personId: MOM, date: '2026-11-10', amount: 2_000_000 });
    await onBehalf(1_000_000, { credit: false }, '2026-11-20'); // untick held money → offset the debt
    const x = await ix();
    expect(owedAt(x, '2026-11-10').total).toBe(12_000_000);
    expect(owedAt(x, '2026-11-11').total).toBe(10_000_000);
    expect(owedAt(x).total).toBe(9_000_000);
  });
});

describe('A repayment is one transaction', () => {
  it('one repayment split across 2 payables is still 1 transaction; a waiver is not a transaction; delete / undo', async () => {
    await setOpening(db, { personId: MOM, date: '2026-11-01', held: 0, owedByMe: 3_000_000, owedToMe: 0 });
    await borrow(db, { personId: MOM, date: '2026-11-02', amount: 2_000_000 });
    await repay(db, { personId: MOM, date: '2026-11-10', amount: 4_000_000, mode: 'transfer', note: 'tháng 11' });
    await waiveDebt(db, { personId: MOM, date: '2026-11-11', amount: 1_000_000 });
    let x = await ix();
    const list = repayTxs(x);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ amount: 4_000_000, mode: 'transfer', note: 'tháng 11' });
    expect(list[0].ids).toHaveLength(2);
    await deleteRepayments(db, list[0].ids);
    expect(await owedOf(db, MOM)).toBe(4_000_000);
    await restoreRepayments(db, list[0].ids);
    x = await ix();
    expect(owedTo(x, MOM)).toBe(0);
    expect(repayTxs(x)).toHaveLength(1);
  });
});

describe('Category Chuyển tiền › Thanh toán hộ', () => {
  it('a new ledger has exactly one such category; an old ledger gets it added once', async () => {
    const find = async () => (await db.categories.toArray()).filter((c) => !c.deletedAt && c.name === PAY_FOR);
    expect(await find()).toHaveLength(1);
    const [c] = await find();
    await db.categories.delete(c.id);
    await db.settings.update('settings', { payForSeeded: false });
    await seedPayFor(db);
    await seedPayFor(db);
    const again = await find();
    expect(again).toHaveLength(1);
    expect(ixParent(await ix(), again[0].parentId!)).toBe('Chuyển tiền');
  });

  it('paying on behalf under Thanh toán hộ: still offsets what I owe, not counted as my spending', async () => {
    await setOpening(db, { personId: MOM, date: '2026-11-01', held: 0, owedByMe: 12_000_000, owedToMe: 0 });
    const payFor = (await db.categories.filter((c) => c.name === PAY_FOR).first())!;
    await saveExpense(db, {
      date: '2026-11-10', kind: 'expense', categoryId: payFor.id, title: 'Trả đối tác của mẹ', totalAmount: 18_000_000, splitMode: 'custom', tagIds: [],
      shares: [{ personId: MOM, type: 'owe', amount: 18_000_000 }], onBehalf: true,
    });
    const x = await ix();
    expect(owedTo(x, MOM)).toBe(0);
    expect(periodStats(x, NOV)).toMatchObject({ mine: 0, spent: 0, repaid: 12_000_000, advanced: 6_000_000 });
  });
});
