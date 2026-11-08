import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { FintoDB, base } from '../db/schema';
import { seedIfEmpty } from '../db/seed';
import { parseAmount, splitEqual, splitRemaining } from './split';
import { creditOf, debtOf, deleteSettlement, deleteTransaction, pickOldest, receivePayment, saveExpense, shareStatus } from './ledger';

let db: FintoDB;
let cat: string;
const P = { an: '', binh: '', chi: '' };

beforeEach(async () => {
  db = new FintoDB('test-' + crypto.randomUUID());
  await seedIfEmpty(db);
  cat = (await db.categories.filter((c) => c.name === 'Ăn uống').first())!.id;
  for (const k of Object.keys(P) as (keyof typeof P)[]) {
    const p = { ...base(), name: k, color: '#fff', defaultType: 'owe' as const };
    await db.people.add(p);
    P[k] = p.id;
  }
});

const lau = (applyCredit?: boolean) =>
  saveExpense(db, {
    date: '2026-11-06', kind: 'expense', categoryId: cat, title: 'Lẩu', totalAmount: 360000, splitMode: 'equal', tagIds: [], applyCredit,
    shares: splitEqual(360000, [
      { personId: null, type: 'mine' }, { personId: P.an, type: 'owe' }, { personId: P.binh, type: 'owe' }, { personId: P.chi, type: 'give' },
    ]),
  });

describe('split', () => {
  it('parse số tiền', () => {
    expect(parseAmount('360k')).toBe(360000);
    expect(parseAmount('360.000')).toBe(360000);
    expect(parseAmount('1,5tr')).toBe(1500000);
  });
  it('RULE-03 phần lẻ vào Của tôi', () => {
    const s = splitEqual(100000, [{ personId: P.an, type: 'owe' }, { personId: null, type: 'mine' }, { personId: P.binh, type: 'owe' }]);
    expect(s.map((x) => x.amount)).toEqual([33000, 34000, 33000]);
  });
  it('chia phần còn lại', () => {
    const s = splitRemaining(300000, [{ personId: null, type: 'mine', amount: 100000 }, { personId: P.an, type: 'owe' }, { personId: P.binh, type: 'owe' }]);
    expect(s.map((x) => x.amount)).toEqual([100000, 100000, 100000]);
  });
});

describe('ledger', () => {
  it('UC-01 lẩu 360k chia 4', async () => {
    await lau();
    expect(await debtOf(db, P.an)).toBe(90000);
    expect(await debtOf(db, P.chi)).toBe(0);
  });

  it('UC-02/03 thu 200k, trừ một phần, dư thành tiền đang giữ', async () => {
    await lau();
    const [d] = await pickOldest(db, P.an, 50000);
    await receivePayment(db, { personId: P.an, date: '2026-11-07', amount: 50000, picks: [d] });
    const sh = (await db.shares.where('personId').equals(P.an).first())!;
    expect(await shareStatus(db, sh)).toBe('partial');
    expect(await debtOf(db, P.an)).toBe(40000);
    await receivePayment(db, { personId: P.an, date: '2026-11-08', amount: 200000, picks: [{ shareId: sh.id, amount: 40000 }] });
    expect(await debtOf(db, P.an)).toBe(0);
    expect(await creditOf(db, P.an)).toBe(160000);
  });

  it('UC-04 gửi trước 500k rồi tự trừ; xóa lần gửi thì khoản quay về Đang chờ', async () => {
    const st = await receivePayment(db, { personId: P.binh, date: '2026-11-06', amount: 500000, picks: [] });
    await lau();
    expect(await debtOf(db, P.binh)).toBe(0);
    expect(await creditOf(db, P.binh)).toBe(410000);
    await deleteSettlement(db, st);
    expect(await creditOf(db, P.binh)).toBe(0);
    expect(await debtOf(db, P.binh)).toBe(90000);
  });

  it('tắt tự trừ cho một giao dịch', async () => {
    await receivePayment(db, { personId: P.binh, date: '2026-11-06', amount: 500000, picks: [] });
    await lau(false);
    expect(await debtOf(db, P.binh)).toBe(90000);
    expect(await creditOf(db, P.binh)).toBe(500000);
  });

  it('xóa giao dịch trả tiền về tiền đang giữ', async () => {
    await receivePayment(db, { personId: P.binh, date: '2026-11-06', amount: 500000, picks: [] });
    const tx = await lau();
    await deleteTransaction(db, tx);
    expect(await creditOf(db, P.binh)).toBe(500000);
    expect(await debtOf(db, P.binh)).toBe(0);
  });

  it('chặn trừ vượt số tiền', async () => {
    await lau();
    const sh = (await db.shares.where('personId').equals(P.an).first())!;
    await expect(receivePayment(db, { personId: P.an, date: '2026-11-07', amount: 10000, picks: [{ shareId: sh.id, amount: 90000 }] })).rejects.toThrow();
  });
});
