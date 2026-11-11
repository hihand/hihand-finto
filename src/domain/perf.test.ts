import { describe, expect, it } from 'vitest';
import type { Allocation, Category, Income, Person, Settlement, Share, Transaction } from '../db/schema';
import { exportSheets } from './export';
import { periodRange } from './period';
import { heldAt, heldLedger, makeIndex, outstanding, peopleSummary, periodStats, personalBalanceAt, yearStats, type Snapshot } from './stats';

/** NFR-01: 10,000 transactions — the calculations for one screen must finish within 1 second. */
function bigSnapshot(n = 10_000): Snapshot {
  const t = '2026-01-01T00:00:00.000Z';
  const b = (id: string) => ({ id, createdAt: t, updatedAt: t, deletedAt: null });
  const people: Person[] = Array.from({ length: 30 }, (_, i) => ({ ...b('p' + i), name: 'Người ' + i, color: '#fff', defaultType: 'owe' }));
  const categories: Category[] = [
    { ...b('c0'), name: 'Ăn uống', icon: 'utensils', parentId: null, countsAsMine: true, sortOrder: 0 },
    { ...b('c1'), name: 'Bữa chính', icon: 'utensils', parentId: 'c0', countsAsMine: true, sortOrder: 0 },
    { ...b('ci'), name: 'Lương', icon: 'wallet', parentId: null, countsAsMine: false, sortOrder: 0, kind: 'income' },
  ];
  const transactions: Transaction[] = [], shares: Share[] = [], settlements: Settlement[] = [], allocations: Allocation[] = [], incomes: Income[] = [];
  for (let i = 0; i < n; i++) {
    const d = `2026-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`;
    const p = people[i % 30].id;
    transactions.push({ ...b('t' + i), date: d, kind: 'expense', categoryId: 'c1', title: 'Giao dịch ' + i, totalAmount: 300_000, splitMode: 'equal', onBehalf: i % 10 === 0 });
    shares.push({ ...b('sm' + i), transactionId: 't' + i, personId: null, type: 'mine', amount: 100_000 });
    shares.push({ ...b('so' + i), transactionId: 't' + i, personId: p, type: 'owe', amount: 100_000 });
    shares.push({ ...b('sg' + i), transactionId: 't' + i, personId: people[(i + 1) % 30].id, type: 'give', amount: 100_000 });
    if (i % 3 === 0) {
      settlements.push({ ...b('st' + i), personId: p, date: d, amount: 150_000, direction: 'in' });
      allocations.push({ ...b('a' + i), settlementId: 'st' + i, shareId: 'so' + i, personId: p, amount: 100_000, kind: 'pay' });
    } else if (i % 3 === 1) allocations.push({ ...b('a' + i), settlementId: null, shareId: 'so' + i, personId: p, amount: 30_000, kind: 'pay' });
    if (i % 20 === 0) allocations.push({ ...b('f' + i), settlementId: null, shareId: 'so' + i, personId: p, amount: 10_000, kind: 'forgive', date: d });
  }
  for (let m = 1; m <= 12; m++) incomes.push({ ...b('i' + m), date: `2026-${String(m).padStart(2, '0')}-10`, categoryId: 'ci', amount: 15_000_000, title: 'Lương', personId: null });
  return { people, categories, tags: [], categoryTags: [], transactions, transactionTags: [], shares, settlements, allocations, incomes,
    settings: { id: 'settings', theme: 'dark', monthStartDay: 1, monthEndNote: true, autoApplyCredit: true, seeded: true, openingBalance: 0, openingDate: '2026-01-01' } };
}

const time = (label: string, f: () => unknown) => { const s = performance.now(); f(); const ms = performance.now() - s; console.log(`  ${label.padEnd(38)} ${ms.toFixed(0)} ms`); return ms; };

describe('NFR-01 performance', () => {
  it('10,000 transactions', () => {
    const snap = bigSnapshot();
    let ix = makeIndex(snap);
    const total =
      time('makeIndex', () => { ix = makeIndex(snap); }) +
      time('Tổng quan (tháng + số dư + đòi lại)', () => { periodStats(ix, periodRange('2026-11')); personalBalanceAt(ix); outstanding(ix); }) +
      time('Thống kê tháng + số dư cuối kỳ', () => { periodStats(ix, periodRange('2026-11')); personalBalanceAt(ix, '2026-12-01'); }) +
      time('Thống kê năm (12 tháng) + số dư cuối năm', () => { yearStats(ix, 2026, '2026-12'); personalBalanceAt(ix, '2027-01-01'); }) +
      time('Mọi người (cho đi + đòi lại)', () => { peopleSummary(ix, 'give'); peopleSummary(ix, 'owe'); }) +
      time('Sổ giữ hộ 1 người', () => heldLedger(ix, 'p1')) +
      time('Xuất Excel (tính dòng)', () => exportSheets(ix, null));
    console.log(`  heldAt(before) = ${heldAt(ix, '2026-06-01')}`);
    expect(total).toBeLessThan(1000);
  });
});
