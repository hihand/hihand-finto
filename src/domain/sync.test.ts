import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { FintoDB, SYNC_TABLES, now } from '../db/schema';
import { seedIfEmpty } from '../db/seed';
import { addPerson } from '../domain/catalog';
import { setOpening } from './debt';
import { saveIncome, setOpeningBalance } from './income';
import { creditOf, deleteTransaction, returnCredit, saveExpense, settle } from './ledger';
import { periodRange } from './period';
import { balanceAt, makeIndex, periodStats, personalBalanceAt, type Snapshot } from './stats';
import { buildPackage, getPeers, importPackage, packageSize, packageToText, pendingFor, readPackage, setDeviceName, type SyncPackage } from './sync';

const NOV = periodRange('2026-11');
const open = async (name: string) => {
  const d = new FintoDB(`sync-${name}-${crypto.randomUUID()}`);
  await seedIfEmpty(d);
  await setDeviceName(d, name);
  return d;
};
const snap = async (d: FintoDB): Promise<Snapshot> => ({
  people: await d.people.toArray(), categories: await d.categories.toArray(), tags: await d.tags.toArray(),
  categoryTags: await d.categoryTags.toArray(), transactions: await d.transactions.toArray(), transactionTags: await d.transactionTags.toArray(),
  shares: await d.shares.toArray(), settlements: await d.settlements.toArray(), allocations: await d.allocations.toArray(),
  incomes: await d.incomes.toArray(), payables: await d.payables.toArray(), repayments: await d.repayments.toArray(), settings: await d.settings.get('settings'),
});
const ix = async (d: FintoDB) => makeIndex(await snap(d));
/** Contents of the synced tables (without _seq — each browser's own sequence). */
const content = async (d: FintoDB) => {
  const out: Record<string, unknown[]> = {};
  for (const t of SYNC_TABLES) {
    out[t] = ((await d.table(t).toArray()) as Record<string, unknown>[])
      .map(({ _seq: _s, ...r }) => r).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }
  return out;
};
/** Send a package from `a` to `b` (through a JSON file, like real use). */
const send = async (a: FintoDB, b: FintoDB, password?: string) => {
  const bId = ((await b.meta.get('device'))!.value as { id: string }).id;
  const peers = await getPeers(a);
  const pkg = await buildPackage(a, peers[bId] ? bId : null);
  const text = await packageToText(pkg, password);
  const read = await readPackage(text, password);
  if (!('pkg' in read)) throw new Error('cần mật khẩu');
  return { pkg, report: await importPackage(b, read.pkg) };
};
const cat = async (d: FintoDB, n: string) => (await d.categories.filter((c) => c.name === n && !c.deletedAt && c.kind !== 'income').first())!.id;
const person = async (d: FintoDB, n: string) => (await d.people.filter((p) => p.name === n && !p.deletedAt).first())!.id;
const lunch = async (d: FintoDB, amount: number, date = '2026-11-05') => saveExpense(d, {
  date, kind: 'expense', categoryId: await cat(d, 'Bữa chính'), title: 'Ăn trưa', totalAmount: amount, splitMode: 'equal', tagIds: [],
  shares: [{ personId: null, type: 'mine', amount }],
});

let A: FintoDB, B: FintoDB;
beforeEach(async () => {
  A = await open('PC1');
  B = await open('PC2');
});

describe('syncing two browsers with JSON packages', () => {
  it('first sync: merges two ledgers, default categories are not duplicated; both sides end identical', async () => {
    await lunch(A, 100_000);
    await lunch(B, 50_000);
    const catsBefore = (await A.categories.toArray()).length;
    const first = await send(A, B);
    expect(first.report.fixes.join(' ')).toMatch(/danh mục trùng/);
    await send(B, A);
    expect(await content(A)).toEqual(await content(B));
    // Live categories equal exactly one default set; B's expense moved to the kept category.
    expect((await A.categories.toArray()).filter((c) => !c.deletedAt)).toHaveLength(catsBefore);
    const x = await ix(A);
    expect(periodStats(x, NOV).mine).toBe(150_000);
    expect(periodStats(x, NOV).byCategory).toHaveLength(1);
  });

  it('only changes are sent; received data is not sent back; the second package is small', async () => {
    await lunch(A, 100_000);
    await send(A, B);
    await send(B, A); // B acknowledges what it received from A
    await lunch(A, 20_000, '2026-11-06');
    const { pkg } = await send(A, B);
    // Only 1 transaction + 1 new share (not the whole ledger again, not what was just received from B).
    expect(packageSize(pkg)).toBe(2);
    const bId = ((await B.meta.get('device'))!.value as { id: string }).id;
    expect(await pendingFor(A, bId)).toBe(2); // B has not acknowledged that package yet
    await send(B, A);
    expect(await pendingFor(A, bId)).toBe(0);
    expect(await content(A)).toEqual(await content(B));
  });

  it('same record edited on two browsers: the later edit wins; a delete on one deletes on the other', async () => {
    const txId = await lunch(A, 100_000);
    await send(A, B);
    await send(B, A);
    await A.transactions.update(txId, { title: 'Sửa ở PC1', updatedAt: now() });
    await B.transactions.update(txId, { title: 'Sửa ở PC2', updatedAt: now() }); // sau
    await send(A, B);
    await send(B, A);
    expect((await A.transactions.get(txId))!.title).toBe('Sửa ở PC2');
    expect(await content(A)).toEqual(await content(B));

    await deleteTransaction(A, txId);
    await send(A, B);
    expect((await B.transactions.get(txId))!.deletedAt).toBeTruthy();
    expect(periodStats(await ix(B), NOV).mine).toBe(0);
  });

  it('people and tags added separately with the same name are merged; debts and held money follow', async () => {
    await addPerson(A, 'Mẹ');
    await addPerson(B, 'Mẹ');
    await setOpening(A, { personId: await person(A, 'Mẹ'), date: '2026-11-01', held: 0, owedByMe: 12_000_000, owedToMe: 0 });
    await settle(B, { personId: await person(B, 'Mẹ'), date: '2026-11-02', amount: 2_000_000, picks: [] });
    await send(A, B);
    await send(B, A);
    for (const d of [A, B]) {
      const x = await ix(d);
      expect(x.people).toHaveLength(1);
      const mom = x.people[0].id;
      expect(await creditOf(d, mom)).toBe(2_000_000);
      expect(x.payables.filter((p) => p.personId === mom)).toHaveLength(1);
    }
    expect(await content(A)).toEqual(await content(B));
  });

  it('three browsers: changes travel A → B → C', async () => {
    const C = await open('Laptop');
    await lunch(A, 100_000);
    await send(A, B);
    await send(B, C);
    expect(periodStats(await ix(C), NOV).mine).toBe(100_000);
    await lunch(C, 30_000);
    await send(C, B);
    await send(B, A);
    expect(periodStats(await ix(A), NOV).mine).toBe(130_000);
    await send(A, C);
    await send(C, A);
    await send(A, B);
    await send(B, C);
    expect(await content(A)).toEqual(await content(B));
    expect(await content(B)).toEqual(await content(C));
  });

  it('shared settings (opening balance) sync; theme does not', async () => {
    await setOpeningBalance(A, 5_000_000, '2026-11-01');
    await B.settings.update('settings', { theme: 'light' });
    await send(A, B);
    const s = await B.settings.get('settings');
    expect(s).toMatchObject({ openingBalance: 5_000_000, openingDate: '2026-11-01', theme: 'light' });
    await saveIncome(B, { date: '2026-11-03', categoryId: (await B.categories.filter((c) => c.name === 'Lương').first())!.id, amount: 1_000_000, title: '', personId: null });
    await send(B, A);
    expect(balanceAt(await ix(A))).toBe(6_000_000);
    expect((await A.settings.get('settings'))!.theme).toBe('dark');
  });

  it('a merge that makes held money negative (both browsers used it): auto-applied rows are removed and reported', async () => {
    await addPerson(A, 'Mẹ');
    const mom = await person(A, 'Mẹ');
    await settle(A, { personId: mom, date: '2026-11-01', amount: 1_000_000, picks: [] });
    await send(A, B);
    await send(B, A);
    // PC1 returns 1M to Mom; PC2 (unaware) pays 1M on behalf from held money.
    await returnCredit(A, mom, 1_000_000, '2026-11-05');
    await saveExpense(B, {
      date: '2026-11-05', kind: 'expense', categoryId: await cat(B, 'Điện'), title: 'Điện nhà mẹ', totalAmount: 1_000_000, splitMode: 'custom', tagIds: [],
      shares: [{ personId: mom, type: 'owe', amount: 1_000_000 }], onBehalf: true,
    });
    const { report } = await send(B, A);
    expect(report.fixes.join(' ')).toMatch(/tiền giữ bị âm/);
    expect(await creditOf(A, mom)).toBe(0);
    await send(A, B);
    expect(await content(A)).toEqual(await content(B));
    expect(personalBalanceAt(await ix(A))).toBe(personalBalanceAt(await ix(B)));
  });
});

describe('sync package', () => {
  it('password encryption; wrong password errors; own package rejected; backup files rejected', async () => {
    await lunch(A, 100_000);
    const text = await packageToText(await buildPackage(A, null), 'bí mật');
    expect(text).not.toContain('Ăn trưa');
    expect(await readPackage(text)).toMatchObject({ needPassword: true, fromName: 'PC1' });
    await expect(readPackage(text, 'sai')).rejects.toThrow(/Sai mật khẩu/);
    const ok = await readPackage(text, 'bí mật');
    expect('pkg' in ok && packageSize(ok.pkg)).toBeGreaterThan(0);
    await expect(importPackage(A, (ok as { pkg: SyncPackage }).pkg)).rejects.toThrow(/chính trình duyệt này/);
    await expect(readPackage(JSON.stringify({ app: 'hihand-finto', version: 1, tables: {} }))).rejects.toThrow(/file sao lưu/);
    await expect(readPackage(JSON.stringify({ app: 'hihand-finto', kind: 'sync', v: 1, from: { id: 'x', name: 'x' }, tables: { evil: [] } }))).rejects.toThrow();
  });

  it('importing the same package twice changes nothing', async () => {
    await lunch(A, 100_000);
    const pkg = await buildPackage(A, null);
    await importPackage(B, pkg);
    const before = await content(B);
    const again = await importPackage(B, pkg);
    expect(again.added + again.updated).toBe(0);
    expect(await content(B)).toEqual(before);
  });

  it('a lost package: no false acknowledgement, the next package resends what is missing', async () => {
    await lunch(A, 100_000);
    await send(A, B);
    await send(B, A);
    const bId = ((await B.meta.get('device'))!.value as { id: string }).id;
    await lunch(A, 10_000, '2026-11-07');
    await buildPackage(A, bId); // this package gets lost
    await lunch(A, 20_000, '2026-11-08');
    await send(A, B); // the new package still has both items because B has not acknowledged
    expect(periodStats(await ix(B), NOV).mine).toBe(130_000);
  });
});
