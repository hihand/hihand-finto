import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { FintoDB, base } from '../db/schema';
import { seedIfEmpty } from '../db/seed';
import { exportSheets } from './export';
import { saveIncome, setOpeningBalance } from './income';
import { creditOf, deleteSettlement, depositCredit, forgiveShare, giftFromCredit, returnCredit, saveExpense, settle } from './ledger';
import { periodRange } from './period';
import { balanceAt, heldAt, heldLedger, makeIndex, openDebts, peopleSummary, periodStats, personalBalanceAt, giftsFromPeople, type Snapshot } from './stats';

let db: FintoDB;
const P = { a: '', b: '' };
const snap = async (): Promise<Snapshot> => ({
  people: await db.people.toArray(), categories: await db.categories.toArray(), tags: await db.tags.toArray(),
  categoryTags: await db.categoryTags.toArray(), transactions: await db.transactions.toArray(), transactionTags: await db.transactionTags.toArray(),
  shares: await db.shares.toArray(), settlements: await db.settlements.toArray(), allocations: await db.allocations.toArray(),
  incomes: await db.incomes.toArray(), settings: await db.settings.get('settings'),
});
const ix = async () => makeIndex(await snap());
const cat = async (n: string) => (await db.categories.filter((c) => c.name === n && c.kind !== 'income').first())!.id;
const NOV = periodRange('2026-11');

/** A 190k meal split with A: A owes 95k. */
const meal = async () => saveExpense(db, {
  date: '2026-11-05', kind: 'expense', categoryId: await cat('Bữa chính'), title: 'Tiền ăn', totalAmount: 190_000, splitMode: 'equal', tagIds: [],
  shares: [{ personId: null, type: 'mine', amount: 95_000 }, { personId: P.a, type: 'owe', amount: 95_000 }],
});

beforeEach(async () => {
  db = new FintoDB('held-' + crypto.randomUUID());
  await seedIfEmpty(db);
  await setOpeningBalance(db, 1_000_000, '2026-11-01');
  for (const k of Object.keys(P) as (keyof typeof P)[]) {
    const p = { ...base(), name: k.toUpperCase(), color: '#fff', defaultType: 'owe' as const };
    await db.people.add(p);
    P[k] = p.id;
  }
});

describe('RULE-18: two balances', () => {
  it('held money is in the account balance but not in My balance; gifts are', async () => {
    await settle(db, { personId: P.b, date: '2026-11-02', amount: 300_000, picks: [] });
    await saveIncome(db, { date: '2026-11-03', categoryId: (await db.categories.filter((c) => c.name === 'Lương').first())!.id, amount: 500_000, title: '', personId: null });
    const x = await ix();
    expect(balanceAt(x)).toBe(1_800_000);
    expect(heldAt(x)).toBe(300_000);
    expect(personalBalanceAt(x)).toBe(1_500_000);
    expect(personalBalanceAt(x, '2026-11-03')).toBe(1_000_000);
  });
});

describe('UC-09: overpaying, the surplus is a gift', () => {
  it('95k repaid + 5k income; nothing held; money in is exactly 100k', async () => {
    await meal();
    const [d] = openDebts(await ix(), P.a);
    const stId = await settle(db, { personId: P.a, date: '2026-11-06', amount: 100_000, picks: [{ shareId: d.share.id, amount: 95_000 }], surplus: 'gift' });
    let x = await ix();
    expect(openDebts(x, P.a)).toHaveLength(0);
    expect(await creditOf(db, P.a)).toBe(0);
    const st = periodStats(x, NOV);
    expect(st).toMatchObject({ received: 95_000, income: 5_000 });
    expect(balanceAt(x)).toBe(1_000_000 - 190_000 + 100_000);
    expect(personalBalanceAt(x)).toBe(balanceAt(x));
    expect(giftsFromPeople(x)).toEqual([expect.objectContaining({ personId: P.a, total: 5_000 })]);
    // deleting the payment → the gifted surplus goes with it, the item is back to Waiting
    await deleteSettlement(db, stId!);
    x = await ix();
    expect(periodStats(x, NOV).income).toBe(0);
    expect(openDebts(x, P.a)[0].remaining).toBe(95_000);
  });

  it('kept by default; if kept by mistake it can be turned into a gift later', async () => {
    await meal();
    const [d] = openDebts(await ix(), P.a);
    await settle(db, { personId: P.a, date: '2026-11-06', amount: 100_000, picks: [{ shareId: d.share.id, amount: 95_000 }] });
    expect(await creditOf(db, P.a)).toBe(5_000);
    const bankBefore = balanceAt(await ix());
    await giftFromCredit(db, P.a, 5_000);
    const x = await ix();
    expect(await creditOf(db, P.a)).toBe(0);
    expect(balanceAt(x)).toBe(bankBefore);
    expect(periodStats(x, NOV)).toMatchObject({ received: 95_000, income: 5_000 });
    await expect(giftFromCredit(db, P.a, 1)).rejects.toThrow();
  });
});

describe('UC-10: underpaying, you give the rest', () => {
  it('90k + forgive 5k → Paid; Given to A 5k; money in 90k; held money untouched', async () => {
    await meal();
    const [d] = openDebts(await ix(), P.a);
    await settle(db, { personId: P.a, date: '2026-11-06', amount: 90_000, picks: [{ shareId: d.share.id, amount: 95_000 }], shortfall: 'forgive' });
    const x = await ix();
    expect(openDebts(x, P.a)).toHaveLength(0);
    expect(await creditOf(db, P.a)).toBe(0);
    const st = periodStats(x, NOV);
    expect(st).toMatchObject({ received: 90_000, forgiven: 5_000, mine: 95_000 });
    expect(st.giveByPerson).toEqual([expect.objectContaining({ personId: P.a, amount: 5_000 })]);
    expect(peopleSummary(x, 'give')[0]).toMatchObject({ personId: P.a, total: 5_000 });
    expect(peopleSummary(x, 'owe')[0].entries[0]).toMatchObject({ status: 'paid', forgiven: 5_000 });
    expect(exportSheets(x, null)[1].rows[0][7]).toBe(5_000);
  });

  it('by default the rest stays owed: 90k applied, 5k left', async () => {
    await meal();
    const [d] = openDebts(await ix(), P.a);
    await settle(db, { personId: P.a, date: '2026-11-06', amount: 90_000, picks: [{ shareId: d.share.id, amount: 95_000 }], shortfall: 'owe' });
    expect(openDebts(await ix(), P.a)[0].remaining).toBe(5_000);
  });

  it('without a choice, over-applying is still blocked', async () => {
    await meal();
    const [d] = openDebts(await ix(), P.a);
    await expect(settle(db, { personId: P.a, date: '2026-11-06', amount: 90_000, picks: [{ shareId: d.share.id, amount: 95_000 }] })).rejects.toThrow();
  });

  it('forgive a whole item without a payment; held money is not used', async () => {
    await settle(db, { personId: P.a, date: '2026-11-01', amount: 50_000, picks: [] });
    const id = await saveExpense(db, {
      date: '2026-11-05', kind: 'expense', categoryId: await cat('Bữa chính'), title: 'Tiền ăn', totalAmount: 95_000, splitMode: 'equal', tagIds: [],
      shares: [{ personId: P.a, type: 'owe', amount: 95_000 }], applyCredit: false,
    });
    const sh = (await db.shares.where('transactionId').equals(id).first())!;
    await forgiveShare(db, sh.id, 95_000, '2026-11-07');
    expect(openDebts(await ix(), P.a)).toHaveLength(0);
    expect(await creditOf(db, P.a)).toBe(50_000);
    await expect(forgiveShare(db, sh.id, 1, '2026-11-07')).rejects.toThrow();
  });
});

describe('UC-11..13: holding, paying on behalf, returning', () => {
  it('B deposits 2M, pays 800k electricity on behalf, gets 1.2M back; My balance unchanged', async () => {
    const personal0 = personalBalanceAt(await ix());
    await settle(db, { personId: P.b, date: '2026-11-01', amount: 2_000_000, picks: [], note: 'nhờ giữ' });
    let x = await ix();
    expect(balanceAt(x)).toBe(3_000_000);
    expect(personalBalanceAt(x)).toBe(personal0);

    await saveExpense(db, {
      date: '2026-11-05', kind: 'expense', categoryId: await cat('Điện'), title: 'Tiền điện nhà B', totalAmount: 800_000, splitMode: 'equal', tagIds: [],
      shares: [{ personId: P.b, type: 'owe', amount: 800_000 }], onBehalf: true, applyCredit: false, // on-behalf payments always use held money
    });
    x = await ix();
    expect(await creditOf(db, P.b)).toBe(1_200_000);
    expect(openDebts(x, P.b)).toHaveLength(0);
    expect(periodStats(x, NOV)).toMatchObject({ mine: 0, onBehalf: 800_000, total: 800_000 });
    expect(personalBalanceAt(x)).toBe(personal0);

    await expect(returnCredit(db, P.b, 1_300_000, '2026-11-20')).rejects.toThrow();
    await returnCredit(db, P.b, 1_200_000, '2026-11-20', 'trả nốt');
    x = await ix();
    expect(await creditOf(db, P.b)).toBe(0);
    expect(balanceAt(x)).toBe(1_000_000);
    expect(personalBalanceAt(x)).toBe(personal0);
    const st = periodStats(x, NOV);
    expect(st).toMatchObject({ received: 2_000_000, returned: 1_200_000, give: 0, net: 0 });
    expect(heldLedger(x, P.b).map((e) => [e.delta, e.balance])).toEqual([[2_000_000, 2_000_000], [-800_000, 1_200_000], [-1_200_000, 0]]);
    expect(exportSheets(x, null)[1].rows.map((r) => r[2])).toEqual(['Nhận', 'Trả lại tiền giữ']);
  });

  it('paying on behalf beyond held money: the excess becomes Owed', async () => {
    await settle(db, { personId: P.b, date: '2026-11-01', amount: 2_000_000, picks: [] });
    await saveExpense(db, {
      date: '2026-11-05', kind: 'expense', categoryId: await cat('Học phí'), title: 'Học phí', totalAmount: 2_500_000, splitMode: 'equal', tagIds: [],
      shares: [{ personId: P.b, type: 'owe', amount: 2_500_000 }], onBehalf: true,
    });
    expect(await creditOf(db, P.b)).toBe(0);
    expect(openDebts(await ix(), P.b)[0].remaining).toBe(500_000);
    await expect(saveExpense(db, {
      date: '2026-11-05', kind: 'expense', categoryId: await cat('Điện'), title: 'x', totalAmount: 10_000, splitMode: 'equal', tagIds: [],
      shares: [{ personId: null, type: 'mine', amount: 10_000 }], onBehalf: true,
    })).rejects.toThrow();
  });

  it('cannot delete a deposit that was partly returned; deleting the return first works', async () => {
    const st = await settle(db, { personId: P.b, date: '2026-11-01', amount: 2_000_000, picks: [] });
    const out = await returnCredit(db, P.b, 1_500_000, '2026-11-02');
    await expect(deleteSettlement(db, st!)).rejects.toThrow();
    expect(await creditOf(db, P.b)).toBe(500_000);
    await deleteSettlement(db, out);
    await deleteSettlement(db, st!);
    expect(await creditOf(db, P.b)).toBe(0);
  });

  it('Linh deposits 20M, several on-behalf payments, tops up; the top-up covers the excess', async () => {
    await depositCredit(db, { personId: P.b, date: '2026-11-01', amount: 20_000_000 });
    const bill = async (amount: number, date: string) => saveExpense(db, {
      date, kind: 'expense', categoryId: await cat('Điện'), title: 'Hóa đơn', totalAmount: amount, splitMode: 'equal', tagIds: [],
      shares: [{ personId: P.b, type: 'owe', amount }], onBehalf: true,
    });
    await bill(1_500_000, '2026-11-05');
    await bill(19_000_000, '2026-11-10'); // 500k over
    expect(await creditOf(db, P.b)).toBe(0);
    expect(openDebts(await ix(), P.b)[0].remaining).toBe(500_000);
    await depositCredit(db, { personId: P.b, date: '2026-11-15', amount: 10_000_000, coverDebts: true });
    const x = await ix();
    expect(openDebts(x, P.b)).toHaveLength(0);
    expect(await creditOf(db, P.b)).toBe(9_500_000);
    expect(heldLedger(x, P.b).at(-1)!.balance).toBe(9_500_000);
    expect(personalBalanceAt(x)).toBe(1_000_000);
  });

  it('RULE-14: left over = income − real spending; on-behalf from held money and advances do not count', async () => {
    const luong = (await db.categories.filter((c) => c.name === 'Lương').first())!.id;
    await saveIncome(db, { date: '2026-11-10', categoryId: luong, amount: 15_000_000, title: '', personId: null });
    await depositCredit(db, { personId: P.b, date: '2026-11-01', amount: 20_000_000 });
    await saveExpense(db, {
      date: '2026-11-05', kind: 'expense', categoryId: await cat('Điện'), title: 'Chi hộ Linh', totalAmount: 8_000_000, splitMode: 'equal', tagIds: [],
      shares: [{ personId: P.b, type: 'owe', amount: 8_000_000 }], onBehalf: true,
    });
    await meal(); // 95k mine + 95k advanced for A (no held money yet)
    let st = periodStats(await ix(), NOV);
    expect(await creditOf(db, P.b)).toBe(12_000_000);
    expect(st).toMatchObject({ income: 15_000_000, spent: 95_000, advanced: 95_000, net: 15_000_000 - 95_000, onBehalf: 8_000_000 });
    // Paying on behalf 1M over held money → the excess is an advance
    await saveExpense(db, {
      date: '2026-11-12', kind: 'expense', categoryId: await cat('Học phí'), title: 'Học phí', totalAmount: 13_000_000, splitMode: 'equal', tagIds: [],
      shares: [{ personId: P.b, type: 'owe', amount: 13_000_000 }], onBehalf: true,
    });
    st = periodStats(await ix(), NOV);
    expect(st).toMatchObject({ advanced: 95_000 + 1_000_000, net: 15_000_000 - 95_000 });
    // Given and forgiven are money really gone
    const [d] = openDebts(await ix(), P.a);
    await forgiveShare(db, d.share.id, 95_000, '2026-11-15');
    st = periodStats(await ix(), NOV);
    expect(st).toMatchObject({ spent: 190_000, advanced: 1_000_000, net: 15_000_000 - 190_000 });
  });

  it('old ledgers get the Bills category', async () => {
    const x = await ix();
    const bill = x.roots.find((c) => c.name === 'Hóa đơn')!;
    expect(x.childrenOf.get(bill.id)!.map((c) => c.name)).toEqual(['Điện', 'Nước', 'Internet', 'Điện thoại', 'Học phí']);
  });
});
