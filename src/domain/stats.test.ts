import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { FintoDB, base } from '../db/schema';
import { seedIfEmpty } from '../db/seed';
import { splitEqual } from './split';
import { applyCreditTo, deleteTransaction, receivePayment, restoreTransaction, saveExpense, updateTransactionMeta } from './ledger';
import { makeIndex, openDebts, outstanding, peopleSummary, periodStats, statusOf, txMatches, type Snapshot } from './stats';
import { periodOf, periodRange, shiftMonth } from './period';
import { addCategory, addTagToCategory, setCountsAsMine } from './catalog';

let db: FintoDB;
const P = { an: '', binh: '', chi: '', linh: '', tuan: '' };
const cat = async (name: string) => (await db.categories.filter((c) => c.name === name && !c.deletedAt && c.kind !== 'income').first())!.id;

async function snap(): Promise<Snapshot> {
  return {
    people: await db.people.toArray(), categories: await db.categories.toArray(), tags: await db.tags.toArray(),
    categoryTags: await db.categoryTags.toArray(), transactions: await db.transactions.toArray(),
    transactionTags: await db.transactionTags.toArray(), shares: await db.shares.toArray(),
    settlements: await db.settlements.toArray(), allocations: await db.allocations.toArray(), settings: await db.settings.get('settings'),
  };
}

beforeEach(async () => {
  db = new FintoDB('stats-' + crypto.randomUUID());
  await seedIfEmpty(db);
  for (const k of Object.keys(P) as (keyof typeof P)[]) {
    const p = { ...base(), name: k, color: '#fff', defaultType: k === 'linh' || k === 'tuan' ? 'give' as const : 'owe' as const };
    await db.people.add(p);
    P[k] = p.id;
  }
});

const lau = async (date = '2026-11-06') => {
  const tag = (await db.tags.filter((t) => t.name === 'bạn bè').first())!.id;
  return saveExpense(db, {
    date, kind: 'expense', categoryId: await cat('Lẩu/nướng/nhà hàng'), title: 'Lẩu', totalAmount: 360000, splitMode: 'equal', tagIds: [tag],
    shares: splitEqual(360000, [
      { personId: null, type: 'mine' }, { personId: P.an, type: 'owe' }, { personId: P.binh, type: 'owe' }, { personId: P.chi, type: 'give' },
    ]),
  });
};

describe('period (RULE-11)', () => {
  it('period by month start day', () => {
    expect(periodRange('2026-11', 1)).toEqual({ from: '2026-11-01', to: '2026-12-01' });
    expect(periodRange('2026-12', 10)).toEqual({ from: '2026-12-10', to: '2027-01-10' });
    expect(periodOf('2026-11-05', 10)).toBe('2026-10');
    expect(periodOf('2026-11-10', 10)).toBe('2026-11');
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
  });
});

describe('stats', () => {
  it('UC-01/UC-07: monthly stats only add Mine, category → subcategory', async () => {
    await lau();
    const ix = makeIndex(await snap());
    const st = periodStats(ix, periodRange('2026-11'));
    expect(st).toMatchObject({ total: 360000, mine: 90000, owe: 180000, give: 90000 });
    expect(st.byCategory[0].name).toBe('Ăn uống');
    expect(st.byCategory[0].subs[0]).toMatchObject({ name: 'Lẩu/nướng/nhà hàng', amount: 90000 });
    expect(st.byTag[0]).toMatchObject({ amount: 90000 });
    expect(st.byTag[0].tag.name).toBe('bạn bè');
    expect(periodStats(ix, periodRange('2026-10')).total).toBe(0);
  });

  it('UC-05: a transfer to my younger brother is not my spending', async () => {
    await saveExpense(db, {
      date: '2026-11-01', kind: 'transfer', categoryId: await cat('Gia đình'), title: 'Tiêu vặt', totalAmount: 500000, splitMode: 'equal', tagIds: [],
      shares: [{ personId: P.tuan, type: 'give', amount: 500000 }],
    });
    const st = periodStats(makeIndex(await snap()), periodRange('2026-11'));
    expect(st).toMatchObject({ total: 500000, mine: 0, give: 500000 });
  });

  it('RULE-02: turning off "Counts as my spending" excludes Mine', async () => {
    await lau();
    await setCountsAsMine(db, await cat('Ăn uống'), false);
    expect(periodStats(makeIndex(await snap()), periodRange('2026-11')).mine).toBe(0);
  });

  it('UC-02/03 + BR-13: status labels and outstanding', async () => {
    await lau('2026-11-01');
    await lau('2026-11-06');
    await receivePayment(db, { personId: P.an, date: '2026-11-07', amount: 130000, picks: [] });
    let ix = makeIndex(await snap());
    const debts = openDebts(ix, P.an);
    expect(debts.map((d) => d.tx.date)).toEqual(['2026-11-01', '2026-11-06']);
    // Second payment 10k: 130k held + 10k covers 90k + 40k (the second item partly applied)
    await receivePayment(db, { personId: P.an, date: '2026-11-08', amount: 10000, picks: [{ shareId: debts[0].share.id, amount: 90000 }, { shareId: debts[1].share.id, amount: 40000 }] });
    ix = makeIndex(await snap());
    const an = peopleSummary(ix, 'owe').find((p) => p.personId === P.an)!;
    expect(an.total).toBe(180000);
    expect(an.waiting).toBe(50000);
    expect(an.entries.map((e) => e.status).sort()).toEqual(['paid', 'partial']);
    expect(ix.credit.get(P.an)).toBe(10000);
    expect(outstanding(ix).find((o) => o.personId === P.an)!.amount).toBe(50000);
    expect(statusOf(ix, debts[1].share)).toBe('partial');
  });

  it('UC-08: total given to one person over time', async () => {
    await lau('2026-09-01');
    await lau('2026-11-06');
    const chi = peopleSummary(makeIndex(await snap()), 'give').find((p) => p.personId === P.chi)!;
    expect(chi.total).toBe(180000);
    expect(chi.entries).toHaveLength(2);
  });

  it('accent-insensitive search by tag, person, category', async () => {
    await lau();
    const ix = makeIndex(await snap());
    const t = ix.txs[0];
    expect(txMatches(ix, t, 'ban be')).toBe(true);
    expect(txMatches(ix, t, 'binh')).toBe(true);
    expect(txMatches(ix, t, 'nha hang')).toBe(true);
    expect(txMatches(ix, t, 'grab')).toBe(false);
  });
});

describe('held money', () => {
  it('apply old items against held money without a new payment', async () => {
    await lau();
    await receivePayment(db, { personId: P.binh, date: '2026-11-07', amount: 500000, picks: [] });
    let ix = makeIndex(await snap());
    const [d] = openDebts(ix, P.binh);
    await expect(applyCreditTo(db, P.binh, [{ shareId: d.share.id, amount: 600000 }])).rejects.toThrow();
    await applyCreditTo(db, P.binh, [{ shareId: d.share.id, amount: 90000 }]);
    ix = makeIndex(await snap());
    expect(ix.credit.get(P.binh)).toBe(410000);
    expect(openDebts(ix, P.binh)).toHaveLength(0);
  });
});

describe('edit / delete / undo', () => {
  it('RULE-09: edit date, category, tags; amount unchanged', async () => {
    const id = await lau();
    const tagId = await addTagToCategory(db, await cat('Ăn uống'), 'ăn khuya');
    await updateTransactionMeta(db, id, { date: '2026-11-07', categoryId: await cat('Bữa chính'), title: 'Lẩu tối', tagIds: [tagId] });
    const ix = makeIndex(await snap());
    const t = ix.tx.get(id)!;
    expect(t).toMatchObject({ date: '2026-11-07', title: 'Lẩu tối', totalAmount: 360000 });
    expect(ix.tagIdsOfTx.get(id)).toEqual([tagId]);
  });

  it('BR-11: undo delete also restores auto-applied rows', async () => {
    await receivePayment(db, { personId: P.binh, date: '2026-11-01', amount: 500000, picks: [] });
    const id = await lau();
    const stamp = await deleteTransaction(db, id);
    let ix = makeIndex(await snap());
    expect(ix.credit.get(P.binh)).toBe(500000);
    await restoreTransaction(db, id, stamp);
    ix = makeIndex(await snap());
    expect(ix.credit.get(P.binh)).toBe(410000);
    expect(outstanding(ix).find((o) => o.personId === P.binh)).toBeUndefined();
  });

  it('a new subcategory inherits the parent flags', async () => {
    const id = await addCategory(db, 'Biếu bố mẹ', await cat('Chuyển tiền'));
    expect((await db.categories.get(id))!.countsAsMine).toBe(false);
    await expect(addCategory(db, 'Biếu bố mẹ', await cat('Chuyển tiền'))).rejects.toThrow();
  });
});
