import 'fake-indexeddb/auto';
import { gzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { FintoDB } from '../db/schema';
import type { Allocation, Category, Income, Person, Settlement, Share, Transaction } from '../db/schema';
import { exportSheets } from './export';
import { periodRange } from './period';
import { newKey, runSync, type Transport } from './relay';
import { buildPackage, setDeviceName } from './sync';
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

/** 5 years × ~20 transactions / day ≈ 40,000 transactions: screen calculations and one full live-sync session. */
describe('40,000 transactions (5 years)', () => {
  it('screen calculations stay under 1 second', () => {
    const snap = bigSnapshot(40_000);
    let ix = makeIndex(snap);
    const total =
      time('makeIndex (40k)', () => { ix = makeIndex(snap); }) +
      time('Tổng quan (40k)', () => { periodStats(ix, periodRange('2026-11')); personalBalanceAt(ix); outstanding(ix); }) +
      time('Thống kê năm (40k)', () => { yearStats(ix, 2026, '2026-12'); personalBalanceAt(ix, '2027-01-01'); }) +
      time('Mọi người (40k)', () => { peopleSummary(ix, 'give'); peopleSummary(ix, 'owe'); });
    expect(total).toBeLessThan(1000);
  });

  it('full live sync to a new device: package size and time', async () => {
    const snap = bigSnapshot(40_000);
    const A = new FintoDB('perf-a-' + crypto.randomUUID());
    const B = new FintoDB('perf-b-' + crypto.randomUUID());
    await setDeviceName(A, 'PC1');
    await setDeviceName(B, 'iPhone');
    await A.transaction('rw', [A.people, A.categories, A.transactions, A.shares, A.settlements, A.allocations, A.incomes, A.settings], async () => {
      await A.people.bulkAdd(snap.people); await A.categories.bulkAdd(snap.categories); await A.transactions.bulkAdd(snap.transactions);
      await A.shares.bulkAdd(snap.shares); await A.settlements.bulkAdd(snap.settlements); await A.allocations.bulkAdd(snap.allocations);
      await A.incomes.bulkAdd(snap.incomes!); await A.settings.put(snap.settings!);
    });
    const pkg = await buildPackage(A, null);
    const json = JSON.stringify(pkg);
    const gz = gzipSync(new TextEncoder().encode(json), { level: 6 });
    console.log(`  package: ${(json.length / 1e6).toFixed(1)} MB JSON → ${(gz.length / 1e6).toFixed(1)} MB gzip (${Math.ceil(gz.length / (256 * 1024))} chunks)`);
    // In-memory pair standing in for the relay.
    const mk = () => {
      let onF: ((f: Uint8Array) => void) | null = null;
      const q: Uint8Array[] = [];
      return { deliver: (f: Uint8Array) => (onF ? onF(f) : q.push(f)), t: null as unknown as Transport, set(f: (x: Uint8Array) => void) { onF = f; q.splice(0).forEach(f); } };
    };
    const a = mk(), b = mk();
    a.t = { send: (f) => { setTimeout(() => b.deliver(f), 0); }, listen: (f) => a.set(f), close: () => {} };
    b.t = { send: (f) => { setTimeout(() => a.deliver(f), 0); }, listen: (f) => b.set(f), close: () => {} };
    const key = newKey();
    const s = performance.now();
    await Promise.all([runSync(A, a.t, key, 'host'), runSync(B, b.t, key, 'guest')]);
    console.log(`  full sync session (fake IndexedDB — much slower than a browser — no network): ${((performance.now() - s) / 1000).toFixed(1)} s`);
    expect(await B.transactions.count()).toBe(40_000);
    expect(gz.length).toBeLessThan(20 * 1024 * 1024);
  }, 300_000);
});
